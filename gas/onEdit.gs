const WEBHOOK_URL = PropertiesService.getScriptProperties().getProperty('WEBHOOK_URL');
const WEBHOOK_SECRET = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');

function onEdit(e) {
  if (!e || !e.range) {
    return;
  }

  const sheet = e.range.getSheet();
  if (sheet.getName() !== 'menu') {
    return;
  }

  const headerRow = 1;
  const editedRow = e.range.getRow();
  if (editedRow <= headerRow) {
    return;
  }

  const approveColumn = findColumnIndex(sheet, 'approveFlag');
  if (approveColumn === -1 || e.range.getColumn() !== approveColumn) {
    return;
  }

  const approveValue = sheet.getRange(editedRow, approveColumn).getValue();
  if (approveValue !== 'Approved') {
    return;
  }

  const idColumn = findColumnIndex(sheet, 'id');
  const stagingColumn = findColumnIndex(sheet, 'aiSuggestedImageUrl');
  const imageColumn = findColumnIndex(sheet, 'imageUrl');
  const descriptionColumn = findColumnIndex(sheet, 'description');
  const aiDescriptionColumn = findColumnIndex(sheet, 'aiSuggestedDescription');

  const id = sheet.getRange(editedRow, idColumn).getValue();
  const stagingUrl = sheet.getRange(editedRow, stagingColumn).getValue();
  const description = sheet.getRange(editedRow, descriptionColumn).getValue();
  const aiDescription = sheet.getRange(editedRow, aiDescriptionColumn).getValue();

  const payload = {
    itemId: id,
    stagingKey: extractKeyFromUrl(stagingUrl),
    publicKey: `public/${id}.jpg`
  };

  const timestamp = Date.now().toString();
  const signature = Utilities.computeHmacSha256Signature(`${timestamp}.${JSON.stringify(payload)}`, WEBHOOK_SECRET);
  const signatureHex = signature.map(function (byte) {
    const v = (byte + 256) % 256;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: {
      'X-Timestamp': timestamp,
      'X-Signature': signatureHex
    },
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(WEBHOOK_URL, options);
  if (response.getResponseCode() >= 400) {
    throw new Error('Webhook送信に失敗しました: ' + response.getContentText());
  }

  sheet.getRange(editedRow, imageColumn).setValue(payload.publicKey);
  sheet.getRange(editedRow, descriptionColumn).setValue(aiDescription || description);
  sheet.getRange(editedRow, findColumnIndex(sheet, 'approvedBy')).setValue(Session.getActiveUser().getEmail());
  sheet.getRange(editedRow, findColumnIndex(sheet, 'approvedAt')).setValue(new Date());
  sheet.getRange(editedRow, findColumnIndex(sheet, 'aiStatus')).setValue('Approved');
}

function findColumnIndex(sheet, columnName) {
  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (var i = 0; i < headerRow.length; i++) {
    if (headerRow[i] === columnName) {
      return i + 1;
    }
  }
  return -1;
}

function extractKeyFromUrl(url) {
  if (!url) {
    return '';
  }
  var match = url.match(/https?:\/\/[^/]+\/(.+)/);
  return match ? match[1] : url;
}
