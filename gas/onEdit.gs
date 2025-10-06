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

  // 4. 承認フラグ列にプルダウン設定
  const colApprove = colIndex('承認フラグ');
  const maxRows = sheet.getMaxRows();
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['-', '承認', '却下'], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(2, colApprove, maxRows - 1, 1).setDataValidation(rule);

  // 5. 保護対象列の保護（警告のみ）
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
    const editedCol = e.range.getColumn();
    const editedRow = e.range.getRow();
    const newValue = e.value || '';

    // （以下、これまで onEdit 内に書いていた処理を丸ごと移す）
    const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const idx = (name) => header.indexOf(name) + 1;
    const colApprove = idx('承認フラグ');
    if (!colApprove || editedCol !== colApprove) return;
    if (newValue !== '承認') return;

    const colId = idx('ID');
    const colStagingKey = idx('AI候補画像URL');
    const colPublicKey = idx('公開画像URL');
    if (!colId || !colStagingKey || !colPublicKey) {
      throw new Error('必要な列が見つかりません');
    }

    const id = sheet.getRange(editedRow, colId).getValue();
    const stagingKey = sheet.getRange(editedRow, colStagingKey).getValue();
    const publicKey = sheet.getRange(editedRow, colPublicKey).getValue();

    const payload = {
      itemId: String(id || ''),
      stagingKey: String(stagingKey || ''),
      publicKey: String(publicKey || '')
    };

    const url = getProp('WEBHOOK_URL');
    const secret = getProp('WEBHOOK_SECRET');
    postSigned(url, secret, payload);

    const colApprovedBy = idx('承認者');
    const colApprovedAt = idx('承認日時');
    if (colApprovedBy) sheet.getRange(editedRow, colApprovedBy).setValue(Session.getActiveUser().getEmail() || 'unknown');
    if (colApprovedAt) sheet.getRange(editedRow, colApprovedAt).setValue(new Date().toISOString());

  } catch (err) {
    Logger.log('handleSheetEdit error: ' + err);
  }
}

function postSigned(url, secret, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const timestamp = String(Date.now());
  const sig = hmacHex(secret, timestamp + '.' + body);
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
    Logger.log('Webhook non-2xx: ' + res.getResponseCode() + ' ' + res.getContentText());
  }
}

function hmacHex(secret, data) {
  const sigBytes = Utilities.computeHmacSha256Signature(data, secret);
  return sigBytes.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function getProp(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error('Script property missing: ' + key);
  return value;
}

