/**
 * メニュー用シートの初期設定
 *  - 論理名ヘッダの列を追加（既にあればスキップ）
 *  - ID列を上から順に採番（ITEM0001 形式）
 *  - 承認フラグ列にプルダウンを設定（-, 承認, 却下）
 *  - 保護対象列を警告付きの保護に設定（エディタは手動で追加）
 */
function setupMenuSheet() {
  const sheet = SpreadsheetApp.getActiveSheet();

  // 追加したい列（論理名）
  const NEW_HEADERS = [
    'ID',
    '公開状態',
    'メーカー',
    'メーカー（スラッグ）',
    'カテゴリ',
    'タグ',
    '説明文',
    'AI候補説明文',
    'AI候補画像URL',
    '公開画像URL',
    'AIステータス',
    '承認フラグ',
    '承認者',
    '承認日時',
    '更新日時'
  ];

  // 保護したい列（必要に応じて調整してください）
  const PROTECTED_HEADERS = [
    'ID',
    '公開画像URL',
    'AIステータス',
    '承認者',
    '承認日時',
    '更新日時'
  ];

  // 1. 現在のヘッダを取得
  const currentHeaders =
    sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  // 2. 追加すべきヘッダだけ右端に追加
  const missing = NEW_HEADERS.filter((name) => !currentHeaders.includes(name));
  if (missing.length > 0) {
    sheet.insertColumnsAfter(sheet.getLastColumn(), missing.length);
    sheet
      .getRange(1, currentHeaders.length + 1, 1, missing.length)
      .setValues([missing]);
  }

  // 再取得して列番号を引けるようにする
  const headers =
    sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIndex = (name) => {
    const idx = headers.indexOf(name);
    if (idx === -1) {
      throw new Error(`${name} 列が見つかりません。`);
    }
    return idx + 1; // 1-based
  };

  // 3. ID列に採番
  const colId = colIndex('ID');
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const idRange = sheet.getRange(2, colId, lastRow - 1, 1);
    const idValues = idRange.getValues();
    for (let i = 0; i < idValues.length; i++) {
      if (!idValues[i][0]) {
        const rowNumber = i + 2; // 2行目が ITEM0001
        idValues[i][0] = Utilities.formatString('ITEM%04d', rowNumber - 1);
      }
    }
    idRange.setValues(idValues);
  }

  // 4. 公開状態列にプルダウン設定（Published/Draft）
  const maxRows = sheet.getMaxRows();
  const colStatus = colIndex('公開状態');
  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['公開', '下書き'], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, colStatus, maxRows - 1, 1).setDataValidation(statusRule);

  // 5. 承認フラグ列にプルダウン設定
  const colApprove = colIndex('承認フラグ');
  const approveRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['-', '承認', '却下'], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, colApprove, maxRows - 1, 1).setDataValidation(approveRule);

  // 6. 保護対象列の保護（警告のみ）
  protectColumns(sheet, headers, PROTECTED_HEADERS);

  SpreadsheetApp.flush();
  Logger.log('シートのセットアップが完了しました。');
}

/**
 * 指定したヘッダ列を警告保護します。
 * 実際に編集者を制限したい場合は、保護設定画面から編集者を追加してください。
 */
function protectColumns(sheet, headers, names) {
  const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  names.forEach((name) => {
    const idx = headers.indexOf(name);
    if (idx === -1) return;
    const column = idx + 1;
    const range = sheet.getRange(1, column, sheet.getMaxRows());

    // 既存保護（同じ説明のもの）があれば削除
    protections
      .filter((p) => p.getDescription() === `${name} 列保護`)
      .forEach((p) => p.remove());

    const protection = range.protect();
    protection.setDescription(`${name} 列保護`);
    protection.setWarningOnly(true); // 必要なら false に変更して編集者を設定
  });
}

function handleSheetEdit(e) {
  try {
    if (!e || !e.range) return;

    const sheet = e.source.getActiveSheet();
    const editedRow = e.range.getRow();
    const editedCol = e.range.getColumn();
    const newValue = e.value ?? '';

    if (editedRow <= 1) return;

    const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const idx = (name) => header.indexOf(name) + 1;

    const colId = idx('ID');
    if (!colId) return;

    const idCell = sheet.getRange(editedRow, colId).getValue();
    const itemId = String(idCell || '').trim();
    if (!itemId) return;

    const colName = idx('商品名');
    const colApprove = idx('承認フラグ');
    const colAiStatus = idx('AIステータス');
    const colStagingKey = idx('AI候補画像URL');
    const colPublicKey = idx('公開画像URL');
    const colPublicImageUrl = idx('公開画像確定URL');
    const colApprovedBy = idx('承認者');
    const colApprovedAt = idx('承認日時');

    const secret = getProp('WEBHOOK_SECRET');
    const webhookUrl = getProp('WEBHOOK_URL');
    const syncUrl = getProp('SYNC_URL');

    if (colName && editedCol === colName) {
      if (colApprove) {
        const cell = sheet.getRange(editedRow, colApprove);
        if (cell.getValue() !== '-') {
          cell.setValue('-');
        }
      }
      if (colAiStatus) {
        const cell = sheet.getRange(editedRow, colAiStatus);
        if (cell.getValue() !== 'NeedsReview') {
          cell.setValue('NeedsReview');
        }
      }
      if (colPublicKey) {
        const cell = sheet.getRange(editedRow, colPublicKey);
        if (cell.getValue()) {
          cell.setValue('');
        }
      }
      if (colPublicImageUrl) {
        const cell = sheet.getRange(editedRow, colPublicImageUrl);
        if (cell.getValue()) {
          cell.setValue('');
        }
      }
    }

    let approved = false;
    if (colApprove && editedCol === colApprove && newValue === '承認') {
      const stagingKeyValue = colStagingKey ? sheet.getRange(editedRow, colStagingKey).getValue() : '';
      const publicKeyValue = colPublicKey ? sheet.getRange(editedRow, colPublicKey).getValue() : '';
      const payload = {
        itemId,
        stagingKey: String(stagingKeyValue || ''),
        publicKey: String(publicKeyValue || '')
      };
      try {
        callSignedApi(webhookUrl, secret, payload);
        if (colApprovedBy) {
          sheet.getRange(editedRow, colApprovedBy).setValue(Session.getActiveUser().getEmail() || 'unknown');
        }
        if (colApprovedAt) {
          sheet.getRange(editedRow, colApprovedAt).setValue(new Date().toISOString());
        }
        approved = true;
      } catch (err) {
        Logger.log('Webhook call failed: ' + err);
      }
    }

    const rowData = collectRowForSync(sheet, editedRow, header);
    if (rowData) {
      try {
        callSignedApi(syncUrl, secret, { action: 'upsert', item: rowData });
        recordKnownId(rowData.id);
      } catch (err) {
        Logger.log('Sync upsert failed: ' + err);
      }

      if (approved) {
        const refreshed = collectRowForSync(sheet, editedRow, header);
        if (refreshed) {
          try {
            callSignedApi(syncUrl, secret, { action: 'upsert', item: refreshed });
          } catch (err) {
            Logger.log('Sync refresh failed: ' + err);
          }
        }
      }
    }
  } catch (err) {
    Logger.log('handleSheetEdit error: ' + err);
  }
}

function callSignedApi(url, secret, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const timestamp = String(Date.now());
  const trimmedSecret = String(secret).trim();

  const payloadBytes = Utilities.newBlob(timestamp + '.' + body, Utilities.Charset.UTF_8).getBytes();
  const keyBytes = Utilities.newBlob(trimmedSecret, Utilities.Charset.UTF_8).getBytes();
  const sigBytes = Utilities.computeHmacSignature(
    Utilities.MacAlgorithm.HMAC_SHA_256,
    payloadBytes,
    keyBytes
  );
  const sig = sigBytes
    .map(function(b) {
      return ('0' + (b & 0xff).toString(16)).slice(-2);
    })
    .join('');

  const options = {
    method: 'post',
    payload: body,
    contentType: 'application/json',
    headers: {
      'X-Timestamp': timestamp,
      'X-Signature': sig
    },
    muteHttpExceptions: true
  };
  const res = UrlFetchApp.fetch(url, options);
  if (Math.floor(res.getResponseCode() / 100) !== 2) {
    Logger.log('Signed API non-2xx: ' + res.getResponseCode() + ' ' + res.getContentText());
  }
  return res;
}

function collectRowForSync(sheet, row, header) {
  const columnCount = header.length;
  const values = sheet.getRange(row, 1, 1, columnCount).getValues()[0];
  const headerIndex = header.reduce((map, name, index) => {
    map[name] = index;
    return map;
  }, {});

  const getCell = (name) => {
    const index = headerIndex[name];
    if (index === undefined || index < 0) {
      return '';
    }
    return values[index];
  };

  const data = {};

  const id = normalizeCell(getCell('ID'));
  if (!id) {
    return null;
  }
  data.id = id;

  const assign = (field, headerName, normalizer = normalizeCell) => {
    const value = normalizer(getCell(headerName));
    data[field] = value;
  };

  assign('name', '商品名');
  // 公開状態は日本語 → 英語（Published/Draft）に正規化
  (function() {
    var raw = normalizeCell(getCell('公開状態'));
    var mapped = raw === '公開' ? 'Published' : (raw === '下書き' ? 'Draft' : '');
    if (mapped) {
      data.status = mapped;
    }
  })();
  assign('maker', 'メーカー');
  assign('makerSlug', 'メーカー（スラッグ）');
  assign('category', 'カテゴリ');
  assign('tags', 'タグ');
  assign('description', '説明文');
  assign('aiSuggestedDescription', 'AI候補説明文');

  const stagingRaw = normalizeCell(getCell('AI候補画像URL'));
  data.aiSuggestedImageUrl = stagingRaw;
  data.stagingKey = extractStorageKey(stagingRaw);

  const publicRaw = normalizeCell(getCell('公開画像URL'));
  data.publicKey = extractStorageKey(publicRaw);

  const publicImageUrl = normalizeCell(getCell('公開画像確定URL'));
  if (publicImageUrl) {
    data.imageUrl = publicImageUrl;
  }

  assign('aiStatus', 'AIステータス');
  // 承認フラグは日本語 → 英語に正規化
  (function() {
    var raw = normalizeCell(getCell('承認フラグ'));
    var mapped = raw === '承認' ? 'Approved' : (raw === '却下' ? 'Rejected' : '-');
    data.approveFlag = mapped;
  })();
  assign('approvedBy', '承認者');
  assign('approvedAt', '承認日時');
  assign('updatedAt', '更新日時');
  assign('country', '国');
  assign('manufacturer', '製造会社');
  assign('distributor', '販売会社');
  assign('distillery', '蒸溜所');
  assign('type', 'タイプ');
  assign('caskNumber', '樽番号');
  assign('caskType', '樽種');
  assign('maturationPlace', '熟成地');
  assign('maturationPeriod', '熟成期間');
  assign('alcoholVolume', '度数', normalizeNumeric);
  assign('availableBottles', '本数', normalizeNumeric);
  assign('price30ml', '30ml', normalizeNumeric);
  assign('price15ml', '15ml', normalizeNumeric);
  assign('price10ml', '10ml', normalizeNumeric);
  assign('notes', '備考');

  return data;
}

function normalizeCell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return new Date(value.getTime()).toISOString();
  }
  return String(value).trim();
}

function normalizeNumeric(value) {
  const text = normalizeCell(value);
  if (!text) return '';
  return text.replace(/[^0-9.]/g, '');
}

function extractStorageKey(value) {
  const text = normalizeCell(value);
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const pathname = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
      return decodeURIComponent(pathname);
    } catch (err) {
      Logger.log('extractStorageKey parse error: ' + err);
      return text;
    }
  }
  return text;
}

function getKnownIds() {
  const raw = PropertiesService.getScriptProperties().getProperty('SYNC_KNOWN_IDS');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.ids)) return parsed.ids;
  } catch (err) {
    Logger.log('getKnownIds parse error: ' + err);
  }
  return [];
}

function setKnownIds(ids) {
  PropertiesService.getScriptProperties().setProperty('SYNC_KNOWN_IDS', JSON.stringify(ids));
}

function recordKnownId(id) {
  const current = new Set(getKnownIds());
  current.add(id);
  setKnownIds(Array.from(current).sort());
}

function syncSheetState() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const lastRow = sheet.getLastRow();
  const secret = getProp('WEBHOOK_SECRET');
  const syncUrl = getProp('SYNC_URL');

  const items = [];
  const currentIds = [];

  for (let row = 2; row <= lastRow; row++) {
    const rowData = collectRowForSync(sheet, row, header);
    if (rowData) {
      items.push(rowData);
      currentIds.push(String(rowData.id));
    }
  }

  const chunkSize = 25;
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    try {
      callSignedApi(syncUrl, secret, { action: 'batch', items: chunk });
    } catch (err) {
      Logger.log('Sync batch failed: ' + err);
    }
  }

  const knownIds = getKnownIds();
  const removed = knownIds.filter((id) => currentIds.indexOf(id) === -1);
  if (removed.length > 0) {
    try {
      callSignedApi(syncUrl, secret, { action: 'delete', itemIds: removed });
    } catch (err) {
      Logger.log('Sync delete failed: ' + err);
    }
  }

  setKnownIds(currentIds.sort());
}

function hmacHex(secret, data) {
  const sigBytes = Utilities.computeHmacSha256Signature(data, secret);
  return sigBytes.map(function(b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('');
}

function getProp(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error('Script property missing: ' + key);
  return value;
}

function scheduledSyncTrigger() {
  try {
    syncSheetState();
  } catch (err) {
    Logger.log('scheduledSyncTrigger error: ' + err);
  }
}

function manualSync() {
  syncSheetState();
}
