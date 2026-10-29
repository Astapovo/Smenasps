// === Google Apps Script: Code.gs (Единый облачный скрипт SmenaSps v1.0 — Delta Sync & Multi-Engineer Edition) ===
// Поддерживает:
// 1. Журнал инцидентов (лист «Журнал») — дельта-синхронизация, защита от перезаписи статусов («Устранено»), дедупликация, разрешение конфликтов
// 2. Сменные сообщения и задачи (лист «Смена_Сообщения») — двусторонняя дельта-синхронизация и статусы задач
// 3. Заметки и решения инженеров (лист «Практические_решения»)
// 4. Справочники ROOT (листы «Справочник_*»)
// 5. Метаданные ревизий и журнал удалений Tombstones (лист «Служебный_Мета»)
// Оптимизация v1.0:
// - Атомарный обмен за 1 запрос (POST delta_sync): запись изменений клиента + возврат свежей дельты с сервера внутри одного LockService
// - Передача только изменившихся записей (since_ts) и поддержка окна оперативного периода (sync_days) + всех открытых инцидентов
// - Автоматическая дедупликация задвоенных записей (по ID и Коду инцидента) с приоритетом статуса «Устранено»
// - Нормализация дат и времени (защита от превращения времени в 30.12.1899 в ячейках Google Таблиц)

const SHEET_JOURNAL = "Журнал";
const SHEET_SHIFT = "Смена_Сообщения";
const SHEET_NOTES = "Практические_решения";
const SHEET_META = "Служебный_Мета";
const DEFAULT_TZ = "Europe/Moscow";

function sanitize(val) {
  if (val === null || val === undefined) return "";
  var s = String(val);
  if (/^[\=\+\-\@\t\r]/.test(s)) {
    return "'" + s;
  }
  return s;
}

// Защита строковых дат (YYYY-MM-DD) и времени (HH:MM) от автопреобразования Google Таблицей в объект Date 1899 года
function sanitizeDateOrTime(val) {
  if (val === null || val === undefined) return "";
  var s = String(val).trim().replace(/^'/, "");
  if (!s) return "";
  return "'" + s;
}

function getSpreadsheetTz(ss) {
  try {
    return (ss && ss.getSpreadsheetTimeZone()) || Session.getScriptTimeZone() || DEFAULT_TZ;
  } catch (e) {
    return DEFAULT_TZ;
  }
}

function normalizeSheetDate(val, tz) {
  if (val === null || val === undefined || val === "") return "";
  if (Object.prototype.toString.call(val) === "[object Date]" && !isNaN(val.getTime())) {
    return Utilities.formatDate(val, tz || DEFAULT_TZ, "yyyy-MM-dd");
  }
  var s = String(val).trim().replace(/^'/, "");
  var iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  var ru = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (ru) return ru[3] + "-" + ("0" + ru[2]).slice(-2) + "-" + ("0" + ru[1]).slice(-2);
  var months = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
  };
  var eng1 = s.match(/([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})/);
  if (eng1 && months[eng1[1]]) return eng1[3] + "-" + months[eng1[1]] + "-" + ("0" + eng1[2]).slice(-2);
  var eng2 = s.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (eng2 && months[eng2[2]]) return eng2[3] + "-" + months[eng2[2]] + "-" + ("0" + eng2[1]).slice(-2);
  return s;
}

function normalizeSheetTime(val, tz) {
  if (val === null || val === undefined || val === "") return "";
  if (Object.prototype.toString.call(val) === "[object Date]" && !isNaN(val.getTime())) {
    return Utilities.formatDate(val, tz || DEFAULT_TZ, "HH:mm");
  }
  var s = String(val).trim().replace(/^'/, "");
  var m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) return ("0" + m[1]).slice(-2) + ":" + m[2];
  return s;
}

function normalizeSheetIso(val, tz) {
  if (val === null || val === undefined || val === "") return "";
  if (Object.prototype.toString.call(val) === "[object Date]" && !isNaN(val.getTime())) {
    return val.toISOString();
  }
  return String(val).trim().replace(/^'/, "");
}

function parseTs(val) {
  if (!val) return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  if (Object.prototype.toString.call(val) === "[object Date]") {
    return isNaN(val.getTime()) ? 0 : val.getTime();
  }
  var s = String(val).trim().replace(/^'/, "");
  if (!s) return 0;
  var num = Number(s);
  if (!isNaN(num) && num > 1000000000000) return num;
  var parsed = Date.parse(s);
  return isNaN(parsed) ? 0 : parsed;
}

// Генерация стабильного ID для старых строк таблицы, у которых не был заполнен столбец A (ID)
function ensureDeterministicId(id, code, date, timeStart, equipment) {
  var cleanId = String(id || "").trim().replace(/^'/, "");
  if (cleanId) return cleanId;
  var rawKey = [String(code || "").trim(), String(date || "").trim(), String(timeStart || "").trim(), String(equipment || "").trim()].join("|");
  var slug = rawKey.replace(/[^a-zA-Z0-9А-Яа-яЁё]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return "inc-auto-" + (slug || "row");
}

function statusRank(st) {
  var s = String(st || "В работе").trim();
  if (s === "Устранено") return 3;
  if (s === "Ожидает ЗИП" || s === "Передано подрядчику") return 2;
  return 1; // "В работе"
}

function getOrCreateSheet(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (headers && headers.length > 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  } else if (sh.getLastRow() === 0 && headers && headers.length > 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sh;
}

// Чтение и запись ключ-значение в листе Служебный_Мета без раздувания строк
function readMetaMap(ss) {
  var sh = ss.getSheetByName(SHEET_META);
  var map = {};
  if (!sh || sh.getLastRow() < 1) return map;
  var vals = sh.getDataRange().getValues();
  for (var i = 0; i < vals.length; i++) {
    var k = String(vals[i][0] || "").trim();
    if (k && k !== "Ключ") {
      map[k] = String(vals[i][1] || "");
    }
  }
  return map;
}

function writeMetaValues(ss, updates) {
  var headers = ["Ключ", "Значение", "Обновлено"];
  var sh = getOrCreateSheet(ss, SHEET_META, headers);
  var vals = sh.getDataRange().getValues();
  if (vals.length === 0 || String(vals[0][0]) !== "Ключ") {
    vals = [headers];
  }
  var keyIndex = {};
  for (var i = 1; i < vals.length; i++) {
    var k = String(vals[i][0] || "").trim();
    if (k) keyIndex[k] = i;
  }
  var nowIso = new Date().toISOString();
  var keys = Object.keys(updates);
  for (var j = 0; j < keys.length; j++) {
    var key = keys[j];
    var valStr = String(updates[key]);
    if (keyIndex[key] !== undefined) {
      vals[keyIndex[key]] = [key, valStr, nowIso];
    } else {
      vals.push([key, valStr, nowIso]);
      keyIndex[key] = vals.length - 1;
    }
  }
  sh.getRange(1, 1, vals.length, 3).setValues(vals);
}

function getDeletedLog(metaMap) {
  try {
    var raw = metaMap["deleted_log"];
    if (!raw) return [];
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

// Объединение описаний и принятых мер при параллельном редактировании двумя инженерами
function mergeDescriptions(existingDesc, incomingDesc) {
  var ex = String(existingDesc || "").trim();
  var inc = String(incomingDesc || "").trim();
  if (!ex) return inc;
  if (!inc) return ex;
  if (ex === inc) return inc;
  if (inc.indexOf(ex) !== -1) return inc;
  if (ex.indexOf(inc) !== -1) return ex;

  var sep = " | Принятые меры: ";
  var exParts = ex.split(sep);
  var incParts = inc.split(sep);
  if (exParts.length > 1 || incParts.length > 1) {
    var base = incParts[0].length >= exParts[0].length ? incParts[0] : exParts[0];
    var measures = [];
    var seen = {};
    var addM = function(arr) {
      for (var i = 1; i < arr.length; i++) {
        var m = arr[i].trim();
        if (m && !seen[m.toLowerCase()]) {
          seen[m.toLowerCase()] = true;
          measures.push(m);
        }
      }
    };
    addM(exParts);
    addM(incParts);
    if (measures.length > 0) {
      return base + sep + measures.join("; ");
    }
  }
  return inc;
}

// Умное разрешение конфликтов инцидента на сервере
function resolveIncidentMerge(exObj, incObj, nowIso) {
  var exTs = parseTs(exObj.updatedAt);
  var incTs = parseTs(incObj.updatedAt);
  var exRank = statusRank(exObj.status);
  var incRank = statusRank(incObj.status);

  // 1. ЗАЩИТА ОТ ОТКАТА СТАТУСА (например, «Устранено» -> «В работе» или «Ожидает ЗИП» -> «В работе»):
  // Если в таблице статус выше (например, уже «Устранено»), а входящий пакет пытается понизить статус,
  // разрешаем понижение ТОЛЬКО если клиент явно передал флаг ручного переоткрытия (explicitReopen === true) И его метка времени новее!
  if (exRank > incRank) {
    var allowDowngrade = Boolean(incObj.explicitReopen === true && incTs > exTs);
    if (!allowDowngrade) {
      var mergedDesc = mergeDescriptions(exObj.desc, incObj.desc);
      var changed = (mergedDesc !== exObj.desc);
      return {
        record: {
          id: exObj.id || incObj.id,
          code: exObj.code || incObj.code,
          date: exObj.date || incObj.date,
          timeStart: exObj.timeStart || incObj.timeStart,
          timeEnd: exObj.timeEnd || incObj.timeEnd,
          downtime: Number(exObj.downtime) || Number(incObj.downtime) || 0,
          equipment: exObj.equipment || incObj.equipment,
          tag: exObj.tag || incObj.tag,
          zone: exObj.zone || incObj.zone,
          desc: mergedDesc,
          engineer: exObj.engineer || incObj.engineer,
          shift: exObj.shift || incObj.shift,
          level: exObj.level || incObj.level || "1",
          status: exObj.status,
          updatedAt: changed ? nowIso : (exObj.updatedAt || nowIso)
        },
        changed: changed
      };
    }
  }

  // 2. ПОВЫШЕНИЕ СТАТУСА (например, «В работе» -> «Устранено» или «В работе» -> «Ожидает ЗИП»):
  // Закрытие или продвижение статуса всегда принимается!
  if (incRank > exRank) {
    return {
      record: {
        id: exObj.id || incObj.id,
        code: incObj.code || exObj.code,
        date: incObj.date || exObj.date,
        timeStart: incObj.timeStart || exObj.timeStart,
        timeEnd: incObj.timeEnd || exObj.timeEnd,
        downtime: Number(incObj.downtime) || Number(exObj.downtime) || 0,
        equipment: incObj.equipment || exObj.equipment,
        tag: incObj.tag !== undefined ? incObj.tag : exObj.tag,
        zone: incObj.zone || exObj.zone,
        desc: mergeDescriptions(exObj.desc, incObj.desc),
        engineer: incObj.engineer || exObj.engineer,
        shift: incObj.shift || exObj.shift,
        level: incObj.level || exObj.level || "1",
        status: incObj.status,
        updatedAt: (incTs > exTs && incObj.updatedAt) ? String(incObj.updatedAt) : nowIso
      },
      changed: true
    };
  }

  // 3. ОДИНАКОВЫЙ РАНГ СТАТУСА: сравниваем метки времени updatedAt
  if (exTs > 0 && incTs < exTs) {
    // Входящий пакет старше серверной записи — сохраняем серверную запись, но проверяем дополнения мер
    var mDesc = mergeDescriptions(exObj.desc, incObj.desc);
    var descChanged = (mDesc !== exObj.desc);
    var copy = {};
    for (var k in exObj) copy[k] = exObj[k];
    if (descChanged) {
      copy.desc = mDesc;
      copy.updatedAt = nowIso;
    }
    return { record: copy, changed: descChanged };
  }

  // Входящая запись новее или равна серверной: проверяем, изменилось ли хоть одно содержательное поле
  var finalDesc = mergeDescriptions(exObj.desc, incObj.desc);
  var finalStatus = incObj.status || exObj.status || "В работе";
  var finalTimeEnd = incObj.timeEnd !== undefined ? incObj.timeEnd : exObj.timeEnd;
  var finalDowntime = incObj.downtime !== undefined ? (Number(incObj.downtime) || 0) : (Number(exObj.downtime) || 0);
  var finalEq = incObj.equipment || exObj.equipment;
  var finalTag = incObj.tag !== undefined ? incObj.tag : exObj.tag;
  var finalZone = incObj.zone || exObj.zone;
  var finalEng = incObj.engineer || exObj.engineer;
  var finalShift = incObj.shift !== undefined ? incObj.shift : exObj.shift;
  var finalLevel = String(incObj.level || exObj.level || "1");
  var finalDate = incObj.date || exObj.date;
  var finalTimeStart = incObj.timeStart || exObj.timeStart;
  var finalCode = incObj.code || exObj.code;

  var isDiff = (
    finalStatus !== exObj.status ||
    finalDesc !== exObj.desc ||
    finalTimeEnd !== exObj.timeEnd ||
    finalDowntime !== (Number(exObj.downtime) || 0) ||
    finalEq !== exObj.equipment ||
    finalTag !== exObj.tag ||
    finalZone !== exObj.zone ||
    finalEng !== exObj.engineer ||
    finalLevel !== String(exObj.level || "1") ||
    finalDate !== exObj.date ||
    finalTimeStart !== exObj.timeStart
  );

  var resolvedUpdatedAt = isDiff
    ? ((incTs > exTs && incObj.updatedAt) ? String(incObj.updatedAt) : nowIso)
    : (exObj.updatedAt || incObj.updatedAt || nowIso);

  return {
    record: {
      id: exObj.id || incObj.id,
      code: finalCode,
      date: finalDate,
      timeStart: finalTimeStart,
      timeEnd: finalTimeEnd,
      downtime: finalDowntime,
      equipment: finalEq,
      tag: finalTag,
      zone: finalZone,
      desc: finalDesc,
      engineer: finalEng,
      shift: finalShift,
      level: finalLevel,
      status: finalStatus,
      updatedAt: resolvedUpdatedAt
    },
    changed: isDiff
  };
}

function rowToIncident(row, tz) {
  var rawId = String(row[0] || "").trim().replace(/^'/, "");
  var code = String(row[1] || "").trim().replace(/^'/, "");
  var date = normalizeSheetDate(row[2], tz);
  var timeStart = normalizeSheetTime(row[3], tz);
  var equipment = String(row[6] || "").trim();
  return {
    id: ensureDeterministicId(rawId, code, date, timeStart, equipment),
    code: code,
    date: date,
    timeStart: timeStart,
    timeEnd: normalizeSheetTime(row[4], tz),
    downtime: Number(row[5]) || 0,
    equipment: equipment,
    tag: String(row[7] || "").trim(),
    zone: String(row[8] || "").trim(),
    desc: String(row[9] || "").trim(),
    engineer: String(row[10] || "").trim(),
    shift: String(row[11] || "").trim(),
    level: String(row[12] || "1").trim(),
    status: String(row[13] || "В работе").trim(),
    updatedAt: normalizeSheetIso(row[14], tz)
  };
}

function incidentToRow(item) {
  var id = ensureDeterministicId(item.id, item.code, item.date, item.timeStart, item.equipment);
  return [
    sanitize(id),
    sanitize(item.code || ""),
    sanitizeDateOrTime(item.date || ""),
    sanitizeDateOrTime(item.timeStart || ""),
    sanitizeDateOrTime(item.timeEnd || ""),
    Number(item.downtime) || 0,
    sanitize(item.equipment || ""),
    sanitize(item.tag || ""),
    sanitize(item.zone || ""),
    sanitize(item.desc || ""),
    sanitize(item.engineer || ""),
    sanitize(item.shift || ""),
    sanitize(item.level || "1"),
    sanitize(item.status || "В работе"),
    sanitize(item.updatedAt || new Date().toISOString())
  ];
}

// Ключ дедупликации по бизнес-полям (если у одной записи на разных устройствах оказались разные ID, но одинаковый код+дата+узел)
function getIncidentNaturalKey(rec) {
  if (!rec || !rec.code) return "";
  return [String(rec.code).trim(), String(rec.date || "").trim(), String(rec.equipment || "").trim()].join("|").toLowerCase();
}

function rowToShiftMsg(row, tz) {
  return {
    id: String(row[0] || "").trim().replace(/^'/, ""),
    type: String(row[1] || "handover").trim(),
    text: String(row[2] || "").trim(),
    author: String(row[3] || "").trim(),
    shift: String(row[4] || "day").trim(),
    date: normalizeSheetDate(row[5], tz),
    time: normalizeSheetTime(row[6], tz),
    target: String(row[7] || "all").trim(),
    equipment: String(row[8] || "").trim(),
    zone: String(row[9] || "").trim(),
    isDone: Boolean(row[10] === true || String(row[10]).toLowerCase() === "true" || row[10] === 1),
    doneBy: String(row[11] || "").trim(),
    doneAt: String(row[12] || "").trim().replace(/^'/, ""),
    pinned: Boolean(row[13] === true || String(row[13]).toLowerCase() === "true" || row[13] === 1),
    updatedAt: normalizeSheetIso(row[14], tz)
  };
}

function shiftMsgToRow(msg) {
  return [
    sanitize(msg.id || ""),
    sanitize(msg.type || "handover"),
    sanitize(msg.text || ""),
    sanitize(msg.author || ""),
    sanitize(msg.shift || "day"),
    sanitizeDateOrTime(msg.date || ""),
    sanitizeDateOrTime(msg.time || ""),
    sanitize(msg.target || "all"),
    sanitize(msg.equipment || ""),
    sanitize(msg.zone || ""),
    Boolean(msg.isDone),
    sanitize(msg.doneBy || ""),
    sanitizeDateOrTime(msg.doneAt || ""),
    Boolean(msg.pinned),
    sanitize(msg.updatedAt || new Date().toISOString())
  ];
}

function rowToNote(row, tz) {
  return {
    id: String(row[0] || "").trim().replace(/^'/, ""),
    category: "custom",
    title: String(row[1] || "").trim(),
    equipment: String(row[2] || "all").trim(),
    content: String(row[3] || "").trim(),
    author: String(row[4] || "").trim(),
    updatedAt: normalizeSheetIso(row[5], tz)
  };
}

function noteToRow(note) {
  return [
    sanitize(note.id || ""),
    sanitize(note.title || ""),
    sanitize(note.equipment || "all"),
    sanitize(note.content || ""),
    sanitize(note.author || ""),
    sanitize(note.updatedAt || new Date().toISOString())
  ];
}

function readDatabasesFromSheets(ss) {
  var getColValues = function(sheetName) {
    var sh = ss.getSheetByName(sheetName);
    if (!sh || sh.getLastRow() < 2) return [];
    var vals = sh.getDataRange().getValues();
    var list = [];
    for (var i = 1; i < vals.length; i++) {
      var v = String(vals[i][0] || "").trim();
      if (v) list.push(v);
    }
    return list;
  };

  var zones = getColValues("Справочник_Зоны");
  var engineers = getColValues("Справочник_Инженеры");

  var equipment = [];
  var shEq = ss.getSheetByName("Справочник_Оборудование");
  if (shEq && shEq.getLastRow() > 1) {
    var vals = shEq.getDataRange().getValues();
    for (var i = 1; i < vals.length; i++) {
      var name = String(vals[i][0] || "").trim();
      var zoneStr = String(vals[i][1] || "all").trim();
      var zList = zoneStr === "all" ? ["all"] : zoneStr.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
      if (name) equipment.push({ name: name, zones: zList.length > 0 ? zList : ["all"] });
    }
  }

  var quickTags = [];
  var shTags = ss.getSheetByName("Справочник_Шаблоны");
  if (shTags && shTags.getLastRow() > 1) {
    var vals = shTags.getDataRange().getValues();
    for (var i = 1; i < vals.length; i++) {
      var text = String(vals[i][0] || "").trim();
      var eqStr = String(vals[i][1] || "all").trim();
      var eqList = eqStr === "all" ? ["all"] : eqStr.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
      if (text) quickTags.push({ text: text, equipments: eqList.length > 0 ? eqList : ["all"] });
    }
  }

  var checklists = [];
  var shCh = ss.getSheetByName("Справочник_Чеклисты");
  if (shCh && shCh.getLastRow() > 1) {
    var vals = shCh.getDataRange().getValues();
    for (var i = 1; i < vals.length; i++) {
      var id = String(vals[i][0] || "").trim();
      var title = String(vals[i][1] || "").trim();
      var desc = String(vals[i][2] || "").trim();
      var grp = String(vals[i][3] || "Регламентный сменный обход (Приём смены)").trim();
      if (title) checklists.push({ id: id || ("c-" + i), title: title, desc: desc, group: grp || "Регламентный сменный обход (Приём смены)" });
    }
  }

  var levels = [];
  var levelsEnabled = false;
  var shLvl = ss.getSheetByName("Справочник_Уровни");
  if (shLvl && shLvl.getLastRow() > 1) {
    var lVals = shLvl.getDataRange().getValues();
    for (var i = 1; i < lVals.length; i++) {
      var lid = String(lVals[i][0] || "").trim();
      var lshort = String(lVals[i][1] || "").trim();
      var ltitle = String(lVals[i][2] || "").trim();
      var lbars = Number(lVals[i][3]) || 1;
      if (i === 1 && String(lVals[i][4] || "").toLowerCase() === "true") levelsEnabled = true;
      if (lshort) levels.push({ id: lid || String(i), short: lshort, title: ltitle || lshort, bars: lbars });
    }
  }

  var kbCategories = [];
  var shKbCats = ss.getSheetByName("Справочник_РазделыБЗ");
  if (shKbCats && shKbCats.getLastRow() > 1) {
    var vals = shKbCats.getDataRange().getValues();
    for (var i = 1; i < vals.length; i++) {
      var id = String(vals[i][0] || "").trim();
      var label = String(vals[i][1] || "").trim();
      var icon = String(vals[i][2] || "note").trim();
      if (id && label) kbCategories.push({ id: id, label: label, icon: icon });
    }
  }

  var kbArticles = [];
  var shKb = ss.getSheetByName("Справочник_БазаЗнаний");
  if (shKb && shKb.getLastRow() > 1) {
    var vals = shKb.getDataRange().getValues();
    for (var i = 1; i < vals.length; i++) {
      var id = String(vals[i][0] || "").trim();
      var category = String(vals[i][1] || "custom").trim();
      var title = String(vals[i][2] || "").trim();
      var content = String(vals[i][3] || "").trim();
      var eqBinding = String(vals[i][4] || "all").trim();
      if (title) kbArticles.push({ id: id || ("kb-" + i), category: category, title: title, content: content, equipment: eqBinding });
    }
  }

  return {
    zones: zones,
    equipment: equipment,
    engineers: engineers,
    quickTags: quickTags,
    checklists: checklists,
    levels: levels,
    levelsEnabled: levelsEnabled,
    kbCategories: kbCategories,
    kbArticles: kbArticles
  };
}

// Фильтрация записей для дельта-ответа клиенту
function filterDeltaPayload(allIncidents, allShift, allNotes, deletedLog, opts, tz) {
  var sinceTs = Number(opts.since_ts || 0);
  var syncDays = opts.sync_days !== undefined ? Number(opts.sync_days) : 0;
  var fullSync = Boolean(opts.full_sync);
  var touchedIds = opts.touchedIds || {};

  var cutoffDateStr = "";
  var cutoffMs = 0;
  if (!fullSync && syncDays > 0) {
    var cutoffDate = new Date(Date.now() - syncDays * 86400000);
    cutoffDateStr = Utilities.formatDate(cutoffDate, tz || DEFAULT_TZ, "yyyy-MM-dd");
    cutoffMs = cutoffDate.getTime();
  }

  var filteredIncidents = [];
  for (var i = 0; i < allIncidents.length; i++) {
    var inc = allIncidents[i];
    var key = inc.id || inc.code;
    var isUnresolved = (inc.status !== "Устранено");
    var uTs = parseTs(inc.updatedAt);

    if (fullSync) {
      filteredIncidents.push(inc);
      continue;
    }

    // При инкрементальном запросе (since_ts > 0):
    // Отдаем всё, что обновилось после since_ts, либо было затронуто в этом запросе, либо находится в активном незакрытом статусе
    if (sinceTs > 0) {
      if (uTs >= sinceTs - 5000 || touchedIds[key] || isUnresolved) {
        if (uTs === 0 && !isUnresolved && cutoffDateStr && inc.date && inc.date < cutoffDateStr) {
          continue;
        }
        filteredIncidents.push(inc);
      }
      continue;
    }

    // При первой синхронизации с ограничением периода (syncDays > 0):
    if (cutoffDateStr) {
      var inDateWindow = (!inc.date || inc.date >= cutoffDateStr || uTs >= cutoffMs);
      if (isUnresolved || inDateWindow) {
        filteredIncidents.push(inc);
      }
    } else {
      filteredIncidents.push(inc);
    }
  }

  var filteredShift = [];
  for (var j = 0; j < allShift.length; j++) {
    var sm = allShift[j];
    var smTs = parseTs(sm.updatedAt);
    var isActiveTask = (sm.type === "leader_task" && !sm.isDone) || sm.pinned;
    if (fullSync || sinceTs === 0) {
      if (!fullSync && cutoffDateStr && sm.date && sm.date < cutoffDateStr && !isActiveTask && smTs < cutoffMs) {
        continue;
      }
      filteredShift.push(sm);
    } else if (smTs >= sinceTs - 5000 || touchedIds[sm.id] || isActiveTask) {
      filteredShift.push(sm);
    }
  }

  var filteredNotes = [];
  for (var k = 0; k < allNotes.length; k++) {
    var nt = allNotes[k];
    var ntTs = parseTs(nt.updatedAt);
    if (fullSync || sinceTs === 0 || ntTs === 0 || ntTs >= sinceTs - 5000 || touchedIds[nt.id]) {
      filteredNotes.push(nt);
    }
  }

  var recentDeleted = [];
  for (var d = 0; d < deletedLog.length; d++) {
    var delItem = deletedLog[d];
    if (sinceTs === 0 || (delItem.ts && delItem.ts >= sinceTs - 60000)) {
      recentDeleted.push(delItem);
    }
  }

  return {
    incidents: filteredIncidents,
    shiftMessages: filteredShift,
    notes: filteredNotes,
    deletedIds: recentDeleted,
    totalIncidentsInCloud: allIncidents.length
  };
}

function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tz = getSpreadsheetTz(ss);
    var params = (e && e.parameter) ? e.parameter : {};
    var action = params.action || "get_all";
    var clientDbVer = Number(params.client_db_version || 0);
    var sinceTs = Number(params.since_ts || 0);
    var syncDays = params.sync_days !== undefined ? Number(params.sync_days) : 0;
    var fullSync = (params.full_sync === "true" || params.full_sync === "1" || action === "get_all");

    var metaMap = readMetaMap(ss);
    var cloudDbVer = Number(metaMap["db_version"] || 0);
    var journalRev = Number(metaMap["journal_rev"] || 0);
    var deletedLog = getDeletedLog(metaMap);
    var serverTs = Date.now();
    var nowIso = new Date(serverTs).toISOString();

    if (action === "get_databases") {
      return ContentService.createTextOutput(JSON.stringify({
        status: "ok",
        server_ts: serverTs,
        db_version: cloudDbVer,
        databases: readDatabasesFromSheets(ss)
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 1. ЧТЕНИЕ И ДЕДУПЛИКАЦИЯ ЖУРНАЛА ИНЦИДЕНТОВ
    var incidents = [];
    var incById = {};
    var incByNatKey = {};
    var shJ = ss.getSheetByName(SHEET_JOURNAL) || ss.getSheetByName("Лист1") || ss.getSheets()[0];
    if (shJ && shJ.getLastRow() > 1) {
      var data = shJ.getDataRange().getValues();
      for (var i = 1; i < data.length; i++) {
        var row = data[i];
        if (!row[0] && !row[1] && !row[6]) continue;
        var rec = rowToIncident(row, tz);
        var natKey = getIncidentNaturalKey(rec);
        var dupIdx = (rec.id && incById[rec.id] !== undefined)
          ? incById[rec.id]
          : ((natKey && incByNatKey[natKey] !== undefined) ? incByNatKey[natKey] : -1);
        if (dupIdx !== -1) {
          incidents[dupIdx] = resolveIncidentMerge(incidents[dupIdx], rec, nowIso).record;
        } else {
          var newIdx = incidents.length;
          incidents.push(rec);
          if (rec.id) incById[rec.id] = newIdx;
          if (natKey) incByNatKey[natKey] = newIdx;
        }
      }
    }

    // 2. ЧТЕНИЕ СМЕННЫХ СООБЩЕНИЙ И ЗАДАЧ
    var shiftMessages = [];
    var shShift = ss.getSheetByName(SHEET_SHIFT);
    if (shShift && shShift.getLastRow() > 1) {
      var sVals = shShift.getDataRange().getValues();
      for (var i = 1; i < sVals.length; i++) {
        var row = sVals[i];
        if (!row[0] && !row[2]) continue;
        shiftMessages.push(rowToShiftMsg(row, tz));
      }
    }

    // 3. ЧТЕНИЕ ПРАКТИЧЕСКИХ РЕШЕНИЙ (Заметок)
    var notes = [];
    var shNotes = ss.getSheetByName(SHEET_NOTES);
    if (shNotes && shNotes.getLastRow() > 1) {
      var noteVals = shNotes.getDataRange().getValues();
      for (var i = 1; i < noteVals.length; i++) {
        var row = noteVals[i];
        if (!row[0] || !row[1]) continue;
        notes.push(rowToNote(row, tz));
      }
    }

    var delta = filterDeltaPayload(incidents, shiftMessages, notes, deletedLog, {
      since_ts: sinceTs,
      sync_days: syncDays,
      full_sync: fullSync
    }, tz);

    var response = {
      status: "ok",
      server_ts: serverTs,
      journal_rev: journalRev || serverTs,
      is_delta: (sinceTs > 0 && !fullSync),
      total_archive_count: delta.totalIncidentsInCloud,
      incidents: delta.incidents,
      shiftMessages: delta.shiftMessages,
      notes: delta.notes,
      deletedIds: delta.deletedIds,
      db_version: cloudDbVer,
      has_db_update: (cloudDbVer > clientDbVer)
    };

    if (cloudDbVer > clientDbVer || action === "get_all") {
      response.databases = readDatabasesFromSheets(ss);
    }

    return ContentService.createTextOutput(JSON.stringify(response))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  var hasLock = false;
  try {
    hasLock = lock.tryLock(30000);
  } catch (lErr) {
    hasLock = false;
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tz = getSpreadsheetTz(ss);
    var payload = {};
    if (e && e.postData && e.postData.contents) {
      try {
        payload = JSON.parse(e.postData.contents);
      } catch (pErr) {
        payload = {};
      }
    }
    var action = payload.action || "sync_journal_and_notes";
    var nowMs = Date.now();
    var nowIso = new Date(nowMs).toISOString();

    // А) СИНХРОНИЗАЦИЯ СПРАВОЧНИКОВ ROOT (sync_databases)
    if (action === "sync_databases") {
      var dbs = payload.databases || {};
      var newVer = payload.db_version || nowMs;

      var batchWriteSheet = function(sheetName, headers, rows) {
        var sh = ss.getSheetByName(sheetName);
        if (!sh) sh = ss.insertSheet(sheetName);
        sh.clear();
        var allData = [headers].concat(rows);
        if (allData.length > 0 && headers.length > 0) {
          sh.getRange(1, 1, allData.length, headers.length).setValues(allData);
        }
      };

      if (dbs.zones && Array.isArray(dbs.zones)) {
        var rows = dbs.zones.map(function(z) { return [sanitize(z)]; }).filter(function(r) { return r[0]; });
        batchWriteSheet("Справочник_Зоны", ["Название зоны"], rows);
      }

      if (dbs.engineers && Array.isArray(dbs.engineers)) {
        var rows = dbs.engineers.map(function(eng) { return [sanitize(eng)]; }).filter(function(r) { return r[0]; });
        batchWriteSheet("Справочник_Инженеры", ["Ф.И.О. инженера"], rows);
      }

      if (dbs.equipment && Array.isArray(dbs.equipment)) {
        var rows = dbs.equipment.map(function(eq) {
          var name = typeof eq === "object" ? (eq.name || "") : String(eq);
          var zones = typeof eq === "object" ? (Array.isArray(eq.zones) ? eq.zones.join(", ") : (eq.zone || "all")) : "all";
          return [sanitize(name), sanitize(zones)];
        }).filter(function(r) { return r[0]; });
        batchWriteSheet("Справочник_Оборудование", ["Наименование оборудования / узла", "Привязка к зонам (через запятую)"], rows);
      }

      if (dbs.quickTags && Array.isArray(dbs.quickTags)) {
        var rows = dbs.quickTags.map(function(tag) {
          var text = typeof tag === "object" ? (tag.text || "") : String(tag);
          var eqs = typeof tag === "object" ? (Array.isArray(tag.equipments) ? tag.equipments.join(", ") : (tag.equipment || "all")) : "all";
          return [sanitize(text), sanitize(eqs)];
        }).filter(function(r) { return r[0]; });
        batchWriteSheet("Справочник_Шаблоны", ["Шаблон решения / Быстрая фраза", "Привязка к оборудованию / узлу"], rows);
      }

      if (dbs.checklists && Array.isArray(dbs.checklists)) {
        var rows = dbs.checklists.map(function(ch) {
          return [
            sanitize(ch.id || ""),
            sanitize(ch.title || ""),
            sanitize(ch.desc || ""),
            sanitize(ch.group || "Регламентный сменный обход (Приём смены)")
          ];
        });
        batchWriteSheet("Справочник_Чеклисты", ["ID", "Заголовок проверки", "Описание / регламент", "Название чек-листа"], rows);
      }

      if (dbs.levels && Array.isArray(dbs.levels)) {
        var lEn = Boolean(dbs.levelsEnabled);
        var rows = dbs.levels.map(function(lv, idx) {
          return [
            sanitize(lv.id || String(idx + 1)),
            sanitize(lv.short || ""),
            sanitize(lv.title || lv.short || ""),
            Number(lv.bars) || 1,
            idx === 0 ? (lEn ? "true" : "false") : ""
          ];
        });
        batchWriteSheet("Справочник_Уровни", ["ID", "Краткое название", "Полное описание", "Полосок (1-3)", "Функция включена"], rows);
      }

      if (dbs.kbCategories && Array.isArray(dbs.kbCategories)) {
        var rows = dbs.kbCategories.map(function(cat) {
          return [sanitize(cat.id || ""), sanitize(cat.label || ""), sanitize(cat.icon || "note")];
        });
        batchWriteSheet("Справочник_РазделыБЗ", ["ID раздела", "Название раздела", "Иконка"], rows);
      }

      if (dbs.kbArticles && Array.isArray(dbs.kbArticles)) {
        var rows = dbs.kbArticles.map(function(kb) {
          return [
            sanitize(kb.id || ""),
            sanitize(kb.category || "custom"),
            sanitize(kb.title || ""),
            sanitize(kb.content || ""),
            sanitize(kb.equipment || "all")
          ];
        });
        batchWriteSheet("Справочник_БазаЗнаний", ["ID", "Категория", "Заголовок статьи", "Содержание (HTML)", "Привязка к оборудованию"], rows);
      }

      writeMetaValues(ss, {
        db_version: String(newVer),
        db_author: "root"
      });

      return ContentService.createTextOutput(JSON.stringify({ status: "ok", db_version: newVer, server_ts: nowMs }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Б) АТОМАРНАЯ ДЕЛЬТА-СИНХРОНИЗАЦИЯ И ОБРАТНАЯ СОВМЕСТИМОСТЬ (delta_sync / sync_journal_and_notes / sync_incidents)
    if (action === "delta_sync" || action === "sync_journal_and_notes" || action === "sync_incidents") {
      var metaMap = readMetaMap(ss);
      var cloudDbVer = Number(metaMap["db_version"] || 0);
      var journalRev = Number(metaMap["journal_rev"] || 0);
      var deletedLog = getDeletedLog(metaMap);
      var deletedMap = {};
      for (var d = 0; d < deletedLog.length; d++) {
        if (deletedLog[d].id) deletedMap[deletedLog[d].id] = deletedLog[d].ts || nowMs;
        if (deletedLog[d].code) deletedMap[deletedLog[d].code] = deletedLog[d].ts || nowMs;
      }

      var incomingDeleted = Array.isArray(payload.deletedIds) ? payload.deletedIds : [];
      var deletedChanged = false;
      for (var di = 0; di < incomingDeleted.length; di++) {
        var delEntry = incomingDeleted[di];
        if (!delEntry || (!delEntry.id && !delEntry.code)) continue;
        var delTs = Number(delEntry.ts) || nowMs;
        var dKey = String(delEntry.id || delEntry.code).trim();
        if (!deletedMap[dKey]) {
          deletedMap[dKey] = delTs;
          if (delEntry.code) deletedMap[String(delEntry.code).trim()] = delTs;
          deletedLog.push({
            id: String(delEntry.id || ""),
            code: String(delEntry.code || ""),
            type: String(delEntry.type || "incident"),
            ts: delTs
          });
          deletedChanged = true;
        }
      }
      if (deletedLog.length > 300) {
        deletedLog = deletedLog.slice(deletedLog.length - 300);
      }

      var touchedIds = {};
      var anySheetModified = false;

      // --- 1. ОБРАБОТКА ЖУРНАЛА ИНЦИДЕНТОВ ---
      var journalHeaders = [
        "ID", "Код инцидента", "Дата", "Время начала", "Время устранения",
        "Простой (мин)", "Оборудование", "Тег/Узел", "Зона", "Описание / Меры",
        "Инженер", "Смена", "Уровень", "Статус", "Дата обновления"
      ];
      var shJ = getOrCreateSheet(ss, SHEET_JOURNAL, journalHeaders);
      var jRaw = shJ.getDataRange().getValues();
      var oldJRowCount = jRaw.length;
      var jRecords = [];
      var jIndexById = {};
      var jIndexByCode = {};
      var jIndexByNatKey = {};
      var jSheetModified = false;

      for (var i = 1; i < jRaw.length; i++) {
        var r = jRaw[i];
        if (!r[0] && !r[1] && !r[6]) continue;
        var rawIdInSheet = String(r[0] || "").trim().replace(/^'/, "");
        var rec = rowToIncident(r, tz);
        if (!rawIdInSheet && rec.id) {
          jSheetModified = true; // Запишем сгенерированный стабильный ID в столбец A
        }
        var delTsId = (rec.id && deletedMap[rec.id]) || (rec.code && deletedMap[rec.code]) || 0;
        if (delTsId && delTsId >= parseTs(rec.updatedAt)) {
          jSheetModified = true;
          continue;
        }
        var natKey = getIncidentNaturalKey(rec);
        var dupIdx = (rec.id && jIndexById[rec.id] !== undefined)
          ? jIndexById[rec.id]
          : ((natKey && jIndexByNatKey[natKey] !== undefined) ? jIndexByNatKey[natKey] : -1);

        if (dupIdx !== -1) {
          // Автоматическое слияние дублей, если они были в таблице
          var mergedDup = resolveIncidentMerge(jRecords[dupIdx], rec, nowIso);
          jRecords[dupIdx] = mergedDup.record;
          jSheetModified = true;
        } else {
          var idx = jRecords.length;
          jRecords.push(rec);
          if (rec.id) jIndexById[rec.id] = idx;
          if (rec.code) jIndexByCode[rec.code] = idx;
          if (natKey) jIndexByNatKey[natKey] = idx;
        }
      }

      var incomingIncidents = Array.isArray(payload.items) ? payload.items : [];
      for (var ii = 0; ii < incomingIncidents.length; ii++) {
        var item = incomingIncidents[ii];
        if (!item) continue;
        var normDate = normalizeSheetDate(item.date, tz);
        var normStart = normalizeSheetTime(item.timeStart, tz);
        var normEq = String(item.equipment || "").trim();
        var itemCode = String(item.code || "").trim();
        var itemId = ensureDeterministicId(item.id, itemCode, normDate, normStart, normEq);

        var delTs = (itemId && deletedMap[itemId]) || (itemCode && deletedMap[itemCode]) || 0;
        if (delTs && delTs >= parseTs(item.updatedAt)) continue;

        var itemNatKey = getIncidentNaturalKey({ code: itemCode, date: normDate, equipment: normEq });
        var existingIdx = -1;
        if (itemId && jIndexById[itemId] !== undefined) existingIdx = jIndexById[itemId];
        else if (itemNatKey && jIndexByNatKey[itemNatKey] !== undefined) existingIdx = jIndexByNatKey[itemNatKey];
        else if (itemCode && jIndexByCode[itemCode] !== undefined) existingIdx = jIndexByCode[itemCode];

        var normalizedIncoming = {
          id: itemId,
          code: itemCode,
          date: normDate,
          timeStart: normStart,
          timeEnd: normalizeSheetTime(item.timeEnd, tz),
          downtime: Number(item.downtime) || 0,
          equipment: normEq,
          tag: String(item.tag || "").trim(),
          zone: String(item.zone || "").trim(),
          desc: String(item.desc || "").trim(),
          engineer: String(item.engineer || "").trim(),
          shift: String(item.shift || "").trim(),
          level: String(item.level || "1").trim(),
          status: String(item.status || "В работе").trim(),
          updatedAt: item.updatedAt ? String(item.updatedAt) : nowIso,
          explicitReopen: Boolean(item.explicitReopen)
        };

        if (existingIdx !== -1) {
          var mergeRes = resolveIncidentMerge(jRecords[existingIdx], normalizedIncoming, nowIso);
          jRecords[existingIdx] = mergeRes.record;
          if (mergeRes.changed) {
            jSheetModified = true;
          }
          touchedIds[mergeRes.record.id || mergeRes.record.code] = true;
        } else {
          var newIdx2 = jRecords.length;
          delete normalizedIncoming.explicitReopen;
          jRecords.push(normalizedIncoming);
          if (normalizedIncoming.id) jIndexById[normalizedIncoming.id] = newIdx2;
          if (normalizedIncoming.code) jIndexByCode[normalizedIncoming.code] = newIdx2;
          if (itemNatKey) jIndexByNatKey[itemNatKey] = newIdx2;
          touchedIds[normalizedIncoming.id || normalizedIncoming.code] = true;
          jSheetModified = true;
        }
      }

      if (jSheetModified) {
        var outJ = [journalHeaders];
        for (var jr = 0; jr < jRecords.length; jr++) {
          outJ.push(incidentToRow(jRecords[jr]));
        }
        shJ.getRange(1, 1, outJ.length, journalHeaders.length).setValues(outJ);
        if (oldJRowCount > outJ.length) {
          shJ.getRange(outJ.length + 1, 1, oldJRowCount - outJ.length, journalHeaders.length).clearContent();
        }
        anySheetModified = true;
      }

      // --- 2. ОБРАБОТКА СМЕННЫХ СООБЩЕНИЙ И ЗАДАЧ ---
      var shiftHeaders = [
        "ID", "Тип", "Текст сообщения", "Автор", "Смена", "Дата", "Время",
        "Кому адресовано", "Оборудование", "Зона", "Выполнено", "Кто выполнил",
        "Когда выполнено", "Закреплено", "Дата обновления"
      ];
      var shS = getOrCreateSheet(ss, SHEET_SHIFT, shiftHeaders);
      var sRaw = shS.getDataRange().getValues();
      var oldSRowCount = sRaw.length;
      var sRecords = [];
      var sIndexById = {};
      var sSheetModified = false;

      for (var si = 1; si < sRaw.length; si++) {
        var sr = sRaw[si];
        if (!sr[0] && !sr[2]) continue;
        var sRec = rowToShiftMsg(sr, tz);
        var sDelTs = sRec.id && deletedMap[sRec.id] ? deletedMap[sRec.id] : 0;
        if (sDelTs && sDelTs >= parseTs(sRec.updatedAt)) {
          sSheetModified = true;
          continue;
        }
        if (sRec.id && sIndexById[sRec.id] !== undefined) {
          sSheetModified = true;
          continue;
        }
        var sIdx = sRecords.length;
        sRecords.push(sRec);
        if (sRec.id) sIndexById[sRec.id] = sIdx;
      }

      var incomingShift = Array.isArray(payload.shiftMessages) ? payload.shiftMessages : [];
      for (var smi = 0; smi < incomingShift.length; smi++) {
        var msg = incomingShift[smi];
        if (!msg || !msg.id) continue;
        var mId = String(msg.id).trim();
        var mDelTs = deletedMap[mId] || 0;
        if (mDelTs && mDelTs >= parseTs(msg.updatedAt)) continue;

        var normMsg = {
          id: mId,
          type: String(msg.type || "handover").trim(),
          text: String(msg.text || "").trim(),
          author: String(msg.author || "").trim(),
          shift: String(msg.shift || "day").trim(),
          date: normalizeSheetDate(msg.date, tz),
          time: normalizeSheetTime(msg.time, tz),
          target: String(msg.target || "all").trim(),
          equipment: String(msg.equipment || "").trim(),
          zone: String(msg.zone || "").trim(),
          isDone: Boolean(msg.isDone),
          doneBy: String(msg.doneBy || "").trim(),
          doneAt: String(msg.doneAt || "").trim(),
          pinned: Boolean(msg.pinned),
          updatedAt: msg.updatedAt ? String(msg.updatedAt) : nowIso
        };

        if (sIndexById[mId] !== undefined) {
          var exS = sRecords[sIndexById[mId]];
          var exSTs = parseTs(exS.updatedAt);
          var incSTs = parseTs(normMsg.updatedAt);
          if (incSTs >= exSTs) {
            var sDiff = (
              exS.text !== normMsg.text ||
              exS.isDone !== normMsg.isDone ||
              exS.pinned !== normMsg.pinned ||
              exS.doneBy !== normMsg.doneBy ||
              exS.type !== normMsg.type ||
              exS.date !== normMsg.date ||
              exS.time !== normMsg.time
            );
            if (sDiff) {
              sRecords[sIndexById[mId]] = normMsg;
              sSheetModified = true;
            }
          }
          touchedIds[mId] = true;
        } else {
          sIndexById[mId] = sRecords.length;
          sRecords.push(normMsg);
          touchedIds[mId] = true;
          sSheetModified = true;
        }
      }

      if (sSheetModified) {
        var outS = [shiftHeaders];
        for (var srIdx = 0; srIdx < sRecords.length; srIdx++) {
          outS.push(shiftMsgToRow(sRecords[srIdx]));
        }
        shS.getRange(1, 1, outS.length, shiftHeaders.length).setValues(outS);
        if (oldSRowCount > outS.length) {
          shS.getRange(outS.length + 1, 1, oldSRowCount - outS.length, shiftHeaders.length).clearContent();
        }
        anySheetModified = true;
      }

      // --- 3. ОБРАБОТКА ПРАКТИЧЕСКИХ РЕШЕНИЙ (Заметок) ---
      var notesHeaders = [
        "ID", "Заголовок решения", "Оборудование / Узел", "Содержание (HTML)",
        "Автор / Инженер", "Дата обновления"
      ];
      var shN = getOrCreateSheet(ss, SHEET_NOTES, notesHeaders);
      var nRaw = shN.getDataRange().getValues();
      var oldNRowCount = nRaw.length;
      var nRecords = [];
      var nIndexById = {};
      var nSheetModified = false;

      for (var ni = 1; ni < nRaw.length; ni++) {
        var nr = nRaw[ni];
        if (!nr[0] || !nr[1]) continue;
        var nRec = rowToNote(nr, tz);
        var nDelTs = nRec.id && deletedMap[nRec.id] ? deletedMap[nRec.id] : 0;
        if (nDelTs && nDelTs >= parseTs(nRec.updatedAt)) {
          nSheetModified = true;
          continue;
        }
        if (nRec.id && nIndexById[nRec.id] !== undefined) {
          nSheetModified = true;
          continue;
        }
        var nIdx = nRecords.length;
        nRecords.push(nRec);
        if (nRec.id) nIndexById[nRec.id] = nIdx;
      }

      var incomingNotes = Array.isArray(payload.notes) ? payload.notes : [];
      for (var nti = 0; nti < incomingNotes.length; nti++) {
        var note = incomingNotes[nti];
        if (!note || !note.id) continue;
        var nId = String(note.id).trim();
        var ntDelTs = deletedMap[nId] || 0;
        if (ntDelTs && ntDelTs >= parseTs(note.updatedAt)) continue;

        var normNote = {
          id: nId,
          category: "custom",
          title: String(note.title || "").trim(),
          equipment: String(note.equipment || "all").trim(),
          content: String(note.content || "").trim(),
          author: String(note.author || "").trim(),
          updatedAt: note.updatedAt ? String(note.updatedAt) : nowIso
        };

        if (nIndexById[nId] !== undefined) {
          var exN = nRecords[nIndexById[nId]];
          if (parseTs(normNote.updatedAt) >= parseTs(exN.updatedAt)) {
            if (exN.title !== normNote.title || exN.content !== normNote.content || exN.equipment !== normNote.equipment) {
              nRecords[nIndexById[nId]] = normNote;
              nSheetModified = true;
            }
          }
          touchedIds[nId] = true;
        } else {
          nIndexById[nId] = nRecords.length;
          nRecords.push(normNote);
          touchedIds[nId] = true;
          nSheetModified = true;
        }
      }

      if (nSheetModified) {
        var outN = [notesHeaders];
        for (var nrIdx = 0; nrIdx < nRecords.length; nrIdx++) {
          outN.push(noteToRow(nRecords[nrIdx]));
        }
        shN.getRange(1, 1, outN.length, notesHeaders.length).setValues(outN);
        if (oldNRowCount > outN.length) {
          shN.getRange(outN.length + 1, 1, oldNRowCount - outN.length, notesHeaders.length).clearContent();
        }
        anySheetModified = true;
      }

      // Обновляем ревизию журнала и лог удалений при наличии изменений
      if (anySheetModified || deletedChanged) {
        journalRev = nowMs;
        var metaUpdates = { journal_rev: String(journalRev) };
        if (deletedChanged) {
          metaUpdates.deleted_log = JSON.stringify(deletedLog);
        }
        writeMetaValues(ss, metaUpdates);
      }

      // Формируем ответ с дельтой изменений для клиента за 1 сетевой запрос!
      var clientDbVer = Number(payload.client_db_version || 0);
      var sinceTs = Number(payload.since_ts || 0);
      var syncDays = payload.sync_days !== undefined ? Number(payload.sync_days) : 0;
      var fullSync = Boolean(payload.full_sync);

      var delta = filterDeltaPayload(jRecords, sRecords, nRecords, deletedLog, {
        since_ts: sinceTs,
        sync_days: syncDays,
        full_sync: fullSync,
        touchedIds: touchedIds
      }, tz);

      var responseObj = {
        status: "ok",
        server_ts: nowMs,
        journal_rev: journalRev || nowMs,
        is_delta: (sinceTs > 0 && !fullSync),
        total_archive_count: delta.totalIncidentsInCloud,
        incidentsCount: incomingIncidents.length,
        shiftCount: incomingShift.length,
        notesCount: incomingNotes.length,
        incidents: delta.incidents,
        shiftMessages: delta.shiftMessages,
        notes: delta.notes,
        deletedIds: delta.deletedIds,
        db_version: cloudDbVer,
        has_db_update: (cloudDbVer > clientDbVer)
      };

      if (cloudDbVer > clientDbVer) {
        responseObj.databases = readDatabasesFromSheets(ss);
      }

      return ContentService.createTextOutput(JSON.stringify(responseObj))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ status: "ok", message: "Unknown action ignored" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    if (hasLock) {
      try {
        lock.releaseLock();
      } catch (ign) {}
    }
  }
}
