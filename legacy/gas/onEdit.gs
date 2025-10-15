/**
 * Bar Ease Hongo メニュー管理スプレッドシート
 * 新フロー: AI補完依頼・公開情報承認はボタン方式、source/published 分離
 */

// ===== 列定義 =====
// 既存列（元情報）は維持、右端に優先公開情報列群を追加
const EXISTING_HEADERS = [
  '国', '製造会社', '販売会社', '蒸溜所', 'タイプ', '樽番号', '商品名', '備考',
  '熟成地', '樽種', '熟成期間', '現行', 'ピート感', '度数', '本数',
  '30ml', '15ml', '10ml'
]; // ※実際のシートの列順に合わせて調整してください

const NEW_HEADERS = [
  '公開商品名', '公開メーカー', '公開カテゴリ', '公開タグ', '公開説明文',
  '公開度数', '公開画像URL',
  'AI補完状態', 'メニュー表示状態',
  'ID', '更新日時'
];

const PROTECTED_HEADERS = [
  'AI補完状態', 'メニュー表示状態', 'ID', '更新日時'
];

// AI補完状態の値
const AI_STATUS = {
  EMPTY: '',           // 何もしていない
  REQUESTED: '依頼済み', // AI補完依頼済み
  SUCCESS: '成功',      // AI補完成功
  FAILED: '失敗'        // AI補完失敗（エラー等）
};

// メニュー表示状態の値
const PUBLISH_STATUS = {
  EMPTY: '',                  // 何もしていない
  VISIBLE: 'メニューに表示',    // メニューに表示（優先公開情報優先、なければ元情報）
  HIDDEN: '非表示'             // 非表示
};

// ===== Script Properties キー =====
const PROP_WEBHOOK_SECRET = 'WEBHOOK_SECRET';
const PROP_AI_REQUEST_URL = 'AI_REQUEST_URL';
const PROP_WEBHOOK_URL = 'WEBHOOK_URL';
const PROP_AI_RESULT_URL = 'AI_RESULT_URL';

// ===== 初期設定 =====
function setupMenuSheet() {
  const sheet = SpreadsheetApp.getActiveSheet();

  // 既存列はそのまま、右端に新規列を追加
  const currentHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const missing = NEW_HEADERS.filter(name => !currentHeaders.includes(name));
  
  if (missing.length > 0) {
    sheet.insertColumnsAfter(sheet.getLastColumn(), missing.length);
    sheet.getRange(1, currentHeaders.length + 1, 1, missing.length).setValues([missing]);
  }

  // 再取得
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIndex = (name) => {
    const idx = headers.indexOf(name);
    if (idx === -1) throw new Error(`${name} 列が見つかりません`);
    return idx + 1;
  };
  
  // ID 自動生成（UUID）
  const colId = colIndex('ID');
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    for (let i = 2; i <= lastRow; i++) {
      const idVal = sheet.getRange(i, colId).getValue();
      if (!idVal) {
        const newId = generateUUID();
        sheet.getRange(i, colId).setValue(newId);
      }
    }
  }
  
  // 保護列の設定
  protectColumns(sheet, headers, PROTECTED_HEADERS);

  // スケジュール設定
  setupScheduledUpdate();

  SpreadsheetApp.flush();
  Logger.log('セットアップ完了');
}

// スケジュール設定（朝方6:00 AMに全体更新）
function setupScheduledUpdate() {
  // 既存のトリガーを削除
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'scheduledBatchUpdate') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  
  // 新しいトリガーを作成（毎日6:00 AM）
  ScriptApp.newTrigger('scheduledBatchUpdate')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();
    
  Logger.log('スケジュール設定完了: 毎日6:00 AMに全体更新を実行');
}

// スケジュール実行される全体更新
function scheduledBatchUpdate() {
  Logger.log('スケジュール全体更新開始');
  
  try {
    const sheet = SpreadsheetApp.getActiveSheet();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const colIndex = (name) => headers.indexOf(name) + 1;
    
    const colId = colIndex('ID');
    const lastRow = sheet.getLastRow();
    
    if (lastRow < 2) {
      Logger.log('データがありません');
      return;
    }
    
    // 全行のIDを取得
    const ids = sheet.getRange(2, colId, lastRow - 1, 1).getValues().flat().filter(id => id);
    
    if (ids.length === 0) {
      Logger.log('IDが見つかりません');
      return;
    }
    
    // AI補完結果を取得
    const resultUrl = PropertiesService.getScriptProperties().getProperty(PROP_AI_RESULT_URL);
    const secret = PropertiesService.getScriptProperties().getProperty(PROP_WEBHOOK_SECRET);
    
    if (!resultUrl || !secret) {
      Logger.log('設定が不完全です');
      return;
    }
    
    const resultResponse = callSignedGet(resultUrl, secret);
    const resultData = JSON.parse(resultResponse);
    
    if (!resultData.items || resultData.items.length === 0) {
      Logger.log('AI補完結果がありません');
      return;
    }
    
    // 各IDに対して結果を反映
    let updatedCount = 0;
    resultData.items.forEach(item => {
      if (item.flags?.aiCompleted) {
        const row = findRowById(sheet, item.id, colId);
        if (row) {
          updateSingleRowFromAiResult(sheet, row, item);
          updatedCount++;
        }
      }
    });
    
    Logger.log(`スケジュール全体更新完了: ${updatedCount}件更新`);
    
  } catch (error) {
    Logger.log(`スケジュール全体更新エラー: ${error.message}`);
  }
}

function protectColumns(sheet, headers, names) {
  const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  names.forEach(name => {
    const idx = headers.indexOf(name);
    if (idx === -1) return;
    const column = idx + 1;
    const range = sheet.getRange(1, column, sheet.getMaxRows());

    protections
      .filter(p => p.getDescription() === `${name} 列保護`)
      .forEach(p => p.remove());

    const protection = range.protect();
    protection.setDescription(`${name} 列保護`);
    protection.setWarningOnly(true);
  });
}

// ===== カスタムメニュー =====
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Bar Ease Hongo')
    .addItem('AI補完を実行 (1行のみ)', 'requestAiCompletion')
    .addItem('メニューに表示 (1行のみ)', 'showInMenu')
    .addItem('メニューから非表示 (1行のみ)', 'hideFromMenu')
    .addSeparator()
    .addItem('最新情報を取得 (1行のみ)', 'getLatestInfoSingleRow')
    .addItem('最新情報を取得 (全体)', 'fetchLatestInfo')
    .addItem('IDを生成 (1行のみ)', 'generateIdForRow')
    .addItem('データ修復 (全体)', 'forceSync')
    .addItem('スケジュール設定', 'manageSchedule')
    .addSeparator()
    .addItem('設定を確認', 'checkSettings')
    .addToUi();
}

// ===== onEdit トリガー（優先公開列編集時に公開状態をクリア＋ID自動採番） =====
function handleSheetEdit(e) {
    if (!e || !e.range) return;

    const sheet = e.source.getActiveSheet();
  const row = e.range.getRow();
  const col = e.range.getColumn();
  
  if (row <= 1) return;
  
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIndex = (name) => headers.indexOf(name) + 1;
  
  const colIdStart = colIndex('公開商品名');
  const colIdEnd = colIndex('公開画像URL');
  const colPublishStatus = colIndex('メニュー表示状態');
  const colId = colIndex('ID');
  const colUpdated = colIndex('更新日時');
  
  // 優先公開列が編集されたら「メニュー表示状態」をクリア
  if (col >= colIdStart && col <= colIdEnd && colPublishStatus > 0) {
    sheet.getRange(row, colPublishStatus).setValue('');
  }
  
  // ID自動生成（新規行）
  const id = sheet.getRange(row, colId).getValue();
  if (!id && colId > 0) {
    const hasData = sheet.getRange(row, 1, 1, colId - 1)
      .getValues()[0]
      .some(val => val !== '');
    
    if (hasData) {
      const newId = generateUUID();
      sheet.getRange(row, colId).setValue(newId);
    }
  }
  
  // 更新日時
  if (colUpdated > 0) {
    sheet.getRange(row, colUpdated).setValue(new Date().toISOString());
  }
}


// ===== ボタン: ID生成 =====
function generateIdForRow() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const activeRange = sheet.getActiveRange();
  const activeRow = activeRange.getRow();
  const lastRow = activeRange.getLastRow();
  
  if (activeRow <= 1) {
    SpreadsheetApp.getUi().alert('エラー', 'データ行を選択してください', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const itemName = getItemName(sheet, activeRow, headers);
  
  // 確認ダイアログ
  let confirmMessage = `IDを生成します\n\n対象: ${itemName} (${activeRow}行目)\n機能: 選択行にUUIDを生成・設定します\n\n続行しますか？`;
  
  // 複数行選択時の警告を追記
  if (activeRow !== lastRow) {
    confirmMessage = `IDを生成します\n\n⚠️ 複数行が選択されています\n選択範囲: ${activeRow}行目〜${lastRow}行目\n${activeRow}行目のみ処理されます\n\n対象: ${itemName} (${activeRow}行目)\n機能: 選択行にUUIDを生成・設定します\n\n続行しますか？`;
  }
  
  const result = SpreadsheetApp.getUi().alert(
    'IDを生成',
    confirmMessage,
    SpreadsheetApp.getUi().ButtonSet.YES_NO
  );
  if (result !== SpreadsheetApp.getUi().Button.YES) {
    return;
  }
  
  const colIndex = (name) => headers.indexOf(name) + 1;
  const colId = colIndex('ID');
  
  if (colId === 0) {
    SpreadsheetApp.getUi().alert('エラー', 'ID列が見つかりません', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
  const currentId = sheet.getRange(activeRow, colId).getValue();
  if (currentId) {
    const overwrite = SpreadsheetApp.getUi().alert(
      'IDが既に存在します',
      `現在のID: ${currentId}\n\n新しいUUIDで上書きしますか？`,
      SpreadsheetApp.getUi().ButtonSet.YES_NO
    );
    if (overwrite !== SpreadsheetApp.getUi().Button.YES) {
      return;
    }
  }
  
  const newId = generateUUID();
  sheet.getRange(activeRow, colId).setValue(newId);
  
  SpreadsheetApp.getUi().alert(
    'ID生成完了',
    `対象: ${itemName}\n\nUUIDを生成して${activeRow}行目に設定しました。`,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ===== ボタン: AI補完依頼 =====
function requestAiCompletion() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const activeRange = sheet.getActiveRange();
  const activeRow = activeRange.getRow();
  const lastRow = activeRange.getLastRow();
  
  if (activeRow <= 1) {
    SpreadsheetApp.getUi().alert('エラー', 'データ行を選択してください', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const itemName = getItemName(sheet, activeRow, headers);
  
  // 確認ダイアログ
  let confirmMessage = `AI補完を実行します\n\n対象: ${itemName} (${activeRow}行目)\n機能: 欠損値や間違った情報をAIで補完・修正します\n\n⚠️ 注意事項:\n• 即座にAI補完を実行し、結果を反映します\n• 処理には10〜30秒かかる場合があります\n• インターネット接続が必要です\n\n続行しますか？`;
  
  // 複数行選択時の警告を追記
  if (activeRow !== lastRow) {
    confirmMessage = `AI補完を実行します\n\n⚠️ 複数行が選択されています\n選択範囲: ${activeRow}行目〜${lastRow}行目\n${activeRow}行目のみ処理されます\n\n対象: ${itemName} (${activeRow}行目)\n機能: 欠損値や間違った情報をAIで補完・修正します\n\n⚠️ 注意事項:\n• 即座にAI補完を実行し、結果を反映します\n• 処理には10〜30秒かかる場合があります\n• インターネット接続が必要です\n\n続行しますか？`;
  }
  
  const result = SpreadsheetApp.getUi().alert(
    'AI補完を実行',
    confirmMessage,
    SpreadsheetApp.getUi().ButtonSet.YES_NO
  );
  if (result !== SpreadsheetApp.getUi().Button.YES) {
    return;
  }
  
  const colIndex = (name) => headers.indexOf(name) + 1;
  
  const colId = colIndex('ID');
  const colAiStatus = colIndex('AI補完状態');
  
  const itemId = sheet.getRange(activeRow, colId).getValue();
  if (!itemId) {
    SpreadsheetApp.getUi().alert('エラー', 'IDが見つかりません', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
  // source データ収集
  const source = collectSourceData(sheet, activeRow, headers);
  
  // AI補完状態を「依頼済み」に
  sheet.getRange(activeRow, colAiStatus).setValue(AI_STATUS.REQUESTED);
  
  // POST /ai/request
  const url = PropertiesService.getScriptProperties().getProperty(PROP_AI_REQUEST_URL);
  const secret = PropertiesService.getScriptProperties().getProperty(PROP_WEBHOOK_SECRET);
  
  if (!url || !secret) {
    SpreadsheetApp.getUi().alert('エラー', 'AI_REQUEST_URL または WEBHOOK_SECRET が未設定です', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
      const payload = {
    itemId: String(itemId),
    source: source
  };
  
  try {
    // AI補完依頼
    callSignedApi(url, payload, secret);
    
    // Callback方式の説明メッセージ
    SpreadsheetApp.getUi().alert(
      'AI補完依頼完了',
      `AI補完を依頼しました。\n\n結果は自動でスプレッドシートに反映されます。\n\n※ 即座に結果を確認したい場合や、\n   待っても結果が反映されない場合は、\n   「最新情報を取得 (1行のみ)」を実行してください。`,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (error) {
    // エラー時は「失敗」に設定
    sheet.getRange(activeRow, colAiStatus).setValue(AI_STATUS.FAILED);
    SpreadsheetApp.getUi().alert('エラー', `エラー: ${error.message}`, SpreadsheetApp.getUi().ButtonSet.OK);
  }
}

// 単一行のAI補完結果を反映
function updateSingleRowFromAiResult(sheet, row, item) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIndex = (name) => headers.indexOf(name) + 1;
  
  const colAiStatus = colIndex('AI補完状態');
  const colPubName = colIndex('公開商品名');
  const colPubMaker = colIndex('公開メーカー');
  const colPubCat = colIndex('公開カテゴリ');
  const colPubTags = colIndex('公開タグ');
  const colPubDesc = colIndex('公開説明文');
  const colPubAbv = colIndex('公開度数');
  const colPubImg = colIndex('公開画像URL');
  
  // AI補完状態を更新
  if (item.flags?.aiFailed) {
    sheet.getRange(row, colAiStatus).setValue(AI_STATUS.FAILED);
  } else if (item.flags?.aiCompleted) {
    sheet.getRange(row, colAiStatus).setValue(AI_STATUS.SUCCESS);
  } else if (item.flags?.aiRequested) {
    // 依頼済みだがまだ完了していない
    sheet.getRange(row, colAiStatus).setValue(AI_STATUS.REQUESTED);
  }
  
  // AI補完結果を優先公開列に反映
  const data = item.published || item.aiSuggested;
  if (data) {
    if (data.name) sheet.getRange(row, colPubName).setValue(data.name);
    if (data.maker) sheet.getRange(row, colPubMaker).setValue(data.maker);
    if (data.category) sheet.getRange(row, colPubCat).setValue(data.category);
    if (data.tags) sheet.getRange(row, colPubTags).setValue(data.tags);
    if (data.description) sheet.getRange(row, colPubDesc).setValue(data.description);
    if (data.alcoholVolume) {
      // 度数を文字列として設定（日付フォーマットを防ぐ）
      const abvValue = typeof data.alcoholVolume === 'number' 
        ? data.alcoholVolume 
        : parseFloat(String(data.alcoholVolume).replace(/[^0-9.]/g, ''));
      if (!isNaN(abvValue)) {
        sheet.getRange(row, colPubAbv).setValue(`${abvValue}%`);
      }
    }
    if (data.imageUrl) sheet.getRange(row, colPubImg).setValue(data.imageUrl);
  }
}

function collectSourceData(sheet, row, headers) {
  const colIndex = (name) => headers.indexOf(name) + 1;
  
  return {
    name: sheet.getRange(row, colIndex('商品名')).getValue() || '',
    maker: sheet.getRange(row, colIndex('製造会社')).getValue() || '',
    category: '',
    tags: sheet.getRange(row, colIndex('ピート感')).getValue() || '',
    description: '',
    alcoholVolume: (() => {
      const value = sheet.getRange(row, colIndex('度数')).getValue();
      if (!value) return '';
      // 数値の場合はそのまま、文字列の場合は数値に変換
      const numeric = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.]/g, ''));
      return isNaN(numeric) ? '' : numeric;
    })(),
    imageUrl: '',
    country: sheet.getRange(row, colIndex('国')).getValue() || '',
    manufacturer: sheet.getRange(row, colIndex('製造会社')).getValue() || '',
    distributor: sheet.getRange(row, colIndex('販売会社')).getValue() || '',
    distillery: sheet.getRange(row, colIndex('蒸溜所')).getValue() || '',
    type: sheet.getRange(row, colIndex('タイプ')).getValue() || '',
    caskNumber: sheet.getRange(row, colIndex('樽番号')).getValue() || '',
    caskType: sheet.getRange(row, colIndex('樽種')).getValue() || '',
    maturationPlace: sheet.getRange(row, colIndex('熟成地')).getValue() || '',
    maturationPeriod: sheet.getRange(row, colIndex('熟成期間')).getValue() || '',
    availableBottles: sheet.getRange(row, colIndex('本数')).getValue() || '',
    price30ml: sheet.getRange(row, colIndex('30ml')).getValue() || '',
    price15ml: sheet.getRange(row, colIndex('15ml')).getValue() || '',
    price10ml: sheet.getRange(row, colIndex('10ml')).getValue() || '',
    notes: sheet.getRange(row, colIndex('備考')).getValue() || ''
  };
}

function collectPublishedData(sheet, row, headers) {
  const colIndex = (name) => headers.indexOf(name) + 1;
  
  return {
    name: sheet.getRange(row, colIndex('公開商品名')).getValue() || '',
    maker: sheet.getRange(row, colIndex('公開メーカー')).getValue() || '',
    category: sheet.getRange(row, colIndex('公開カテゴリ')).getValue() || '',
    tags: sheet.getRange(row, colIndex('公開タグ')).getValue() || '',
    description: sheet.getRange(row, colIndex('公開説明文')).getValue() || '',
    alcoholVolume: (() => {
      const value = sheet.getRange(row, colIndex('公開度数')).getValue();
      if (!value) return '';
      // 数値の場合はそのまま、文字列の場合は数値に変換
      const numeric = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.]/g, ''));
      return isNaN(numeric) ? '' : numeric;
    })(),
    imageUrl: sheet.getRange(row, colIndex('公開画像URL')).getValue() || ''
  };
}

// ===== ボタン: メニューに表示 =====
function showInMenu() {
  publishInfo(PUBLISH_STATUS.VISIBLE);
}

// ===== ボタン: メニューから非表示 =====
function hideFromMenu() {
  publishInfo(PUBLISH_STATUS.HIDDEN);
}

// ===== 共通: メニュー表示制御処理 =====
function publishInfo(newPublishStatus) {
  const sheet = SpreadsheetApp.getActiveSheet();
  const activeRange = sheet.getActiveRange();
  const activeRow = activeRange.getRow();
  const lastRow = activeRange.getLastRow();
  
  if (activeRow <= 1) {
    SpreadsheetApp.getUi().alert('データ行を選択してください');
    return;
  }
  
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const itemName = getItemName(sheet, activeRow, headers);
  
  // 確認ダイアログ
  let actionName = '';
  let actionDescription = '';
  let notes = '';
  
  if (newPublishStatus === PUBLISH_STATUS.VISIBLE) {
    actionName = 'メニューに表示';
    actionDescription = 'この商品をWebアプリのメニューに表示します';
    notes = '⚠️ 注意事項:\n• 優先公開情報（公開商品名など）があればそちらを表示します\n• 優先公開情報がない項目は元情報を表示します\n• メニュー表示状態は「メニューに表示」に変更されます';
  } else if (newPublishStatus === PUBLISH_STATUS.HIDDEN) {
    actionName = 'メニューから非表示';
    actionDescription = 'この商品をWebアプリのメニューから非表示にします';
    notes = '⚠️ 注意事項:\n• メニュー表示状態は「非表示」に変更されます\n• お客様のメニューからは表示されなくなります';
  }
  
  let confirmMessage = `${actionName}を実行します\n\n対象: ${itemName} (${activeRow}行目)\n機能: ${actionDescription}\n\n${notes}\n\n続行しますか？`;
  
  // 複数行選択時の警告を追記
  if (activeRow !== lastRow) {
    confirmMessage = `${actionName}を実行します\n\n⚠️ 複数行が選択されています\n選択範囲: ${activeRow}行目〜${lastRow}行目\n${activeRow}行目のみ処理されます\n\n対象: ${itemName} (${activeRow}行目)\n機能: ${actionDescription}\n\n${notes}\n\n続行しますか？`;
  }
  
  const result = SpreadsheetApp.getUi().alert(
    actionName,
    confirmMessage,
    SpreadsheetApp.getUi().ButtonSet.YES_NO
  );
  if (result !== SpreadsheetApp.getUi().Button.YES) {
    return;
  }
  
  const colIndex = (name) => headers.indexOf(name) + 1;
  
  const colId = colIndex('ID');
  const colPublishStatus = colIndex('メニュー表示状態');
  
  const itemId = sheet.getRange(activeRow, colId).getValue();
  if (!itemId) {
    SpreadsheetApp.getUi().alert('IDが見つかりません');
    return;
  }
  
  const source = collectSourceData(sheet, activeRow, headers);
  const published = collectPublishedData(sheet, activeRow, headers);
  
  // メニュー表示状態を設定
  sheet.getRange(activeRow, colPublishStatus).setValue(newPublishStatus);
  
  // POST /webhook
  const url = PropertiesService.getScriptProperties().getProperty(PROP_WEBHOOK_URL);
  const secret = PropertiesService.getScriptProperties().getProperty(PROP_WEBHOOK_SECRET);
  
  if (!url || !secret) {
    SpreadsheetApp.getUi().alert('WEBHOOK_URL または WEBHOOK_SECRET が未設定です');
    return;
  }
  
  // Lambda側へ送信するpayload
  // publishStatus: メニューに表示するかどうか（'表示' or '非表示'）
  // published: 優先公開情報（Lambda側で空チェックして元情報とマージ）
  const payload = {
    itemId: String(itemId),
    source: source,
    published: published,
    publishStatus: newPublishStatus === PUBLISH_STATUS.VISIBLE ? '表示' : '非表示'
  };
  
  try {
    callSignedApi(url, payload, secret);
    const message = newPublishStatus === PUBLISH_STATUS.VISIBLE
      ? `メニューに表示しました\n\n対象: ${itemName}`
      : `メニューから非表示にしました\n\n対象: ${itemName}`;
    SpreadsheetApp.getUi().alert(message);
  } catch (error) {
    SpreadsheetApp.getUi().alert(`エラー: ${error.message}`);
  }
}

// ===== ボタン: 現状強制同期 =====
function forceSync() {
  // 確認ダイアログ
  const result = SpreadsheetApp.getUi().alert(
    'データ修復',
    'データ修復を実行します\n\n対象: 全データ\n機能: スプレッドシートとWebアプリのデータを同期・修復します\n\n⚠️ 注意事項:\n• この機能は未実装です\n• データの不整合が発生した場合は管理者に連絡してください\n• 実行しても何も処理されません\n\n続行しますか？',
    SpreadsheetApp.getUi().ButtonSet.YES_NO
  );
  if (result !== SpreadsheetApp.getUi().Button.YES) {
    return;
  }
  
  // 既存のsyncMenuHandler相当の処理（必要なら実装）
  SpreadsheetApp.getUi().alert('データ修復は未実装です');
}

// ===== ボタン: スケジュール設定 =====
function manageSchedule() {
  const triggers = ScriptApp.getProjectTriggers();
  const scheduledTrigger = triggers.find(trigger => 
    trigger.getHandlerFunction() === 'scheduledBatchUpdate'
  );
  
  let message = 'スケジュール設定状況:\n\n';
  
  if (scheduledTrigger) {
    message += '✅ 全体更新スケジュール: 有効\n';
    message += '実行時間: 毎日 6:00 AM\n';
    message += '機能: AI補完結果の一括反映\n\n';
    message += 'スケジュールを無効にしますか？';
    
    const result = SpreadsheetApp.getUi().alert(
      'スケジュール設定',
      message,
      SpreadsheetApp.getUi().ButtonSet.YES_NO
    );
    
    if (result === SpreadsheetApp.getUi().Button.YES) {
      ScriptApp.deleteTrigger(scheduledTrigger);
      SpreadsheetApp.getUi().alert('スケジュールを無効にしました');
    }
  } else {
    message += '❌ 全体更新スケジュール: 無効\n\n';
    message += 'スケジュールを有効にしますか？\n';
    message += '（毎日 6:00 AM に自動実行）';
    
    const result = SpreadsheetApp.getUi().alert(
      'スケジュール設定',
      message,
      SpreadsheetApp.getUi().ButtonSet.YES_NO
    );
    
    if (result === SpreadsheetApp.getUi().Button.YES) {
      setupScheduledUpdate();
      SpreadsheetApp.getUi().alert('スケジュールを有効にしました');
    }
  }
}

// ===== ボタン: 設定確認 =====
function checkSettings() {
  const props = PropertiesService.getScriptProperties();
  const aiRequestUrl = props.getProperty(PROP_AI_REQUEST_URL);
  const webhookUrl = props.getProperty(PROP_WEBHOOK_URL);
  const aiResultUrl = props.getProperty(PROP_AI_RESULT_URL);
  const webhookSecret = props.getProperty(PROP_WEBHOOK_SECRET);
  
  const message = `
設定状況:
• AI_REQUEST_URL: ${aiRequestUrl ? '✓ 設定済み' : '✗ 未設定'}
• WEBHOOK_URL: ${webhookUrl ? '✓ 設定済み' : '✗ 未設定'}
• AI_RESULT_URL: ${aiResultUrl ? '✓ 設定済み' : '✗ 未設定'}
• WEBHOOK_SECRET: ${webhookSecret ? '✓ 設定済み' : '✗ 未設定'}

未設定の項目がある場合は、Apps Script エディタで
「プロジェクトの設定」→「スクリプト プロパティ」から設定してください。

設定例:
• AI_REQUEST_URL: https://your-api-gateway-url/ai/request
• WEBHOOK_URL: https://your-api-gateway-url/webhook
• AI_RESULT_URL: https://your-api-gateway-url/ai/result
• WEBHOOK_SECRET: your-secret-key
  `;
  
  SpreadsheetApp.getUi().alert(message);
}

// ===== ボタン: 最新情報取得 (1行のみ) =====
function getLatestInfoSingleRow() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const activeRange = sheet.getActiveRange();
  const activeRow = activeRange.getRow();
  const lastRow = activeRange.getLastRow();
  
  if (activeRow <= 1) {
    SpreadsheetApp.getUi().alert('エラー', 'データ行を選択してください', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const itemName = getItemName(sheet, activeRow, headers);
  
  // 確認ダイアログ
  const result = SpreadsheetApp.getUi().alert(
    '最新情報を取得 (1行のみ)',
    `対象: ${itemName}\n\nこの行の最新情報を取得します。\n\n※ 複数行が選択されている場合は、\n   最初の行のみが処理されます。`,
    SpreadsheetApp.getUi().ButtonSet.YES_NO
  );
  
  if (result !== SpreadsheetApp.getUi().Button.YES) {
    return;
  }
  
  const colIndex = (name) => headers.indexOf(name) + 1;
  const colId = colIndex('ID');
  
  const itemId = sheet.getRange(activeRow, colId).getValue();
  if (!itemId) {
    SpreadsheetApp.getUi().alert('エラー', 'IDが見つかりません', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
  const url = PropertiesService.getScriptProperties().getProperty(PROP_AI_RESULT_URL);
  const secret = PropertiesService.getScriptProperties().getProperty(PROP_WEBHOOK_SECRET);
  
  if (!url || !secret) {
    SpreadsheetApp.getUi().alert('エラー', 'AI_RESULT_URL または WEBHOOK_SECRET が未設定です', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
  try {
    const fullUrl = `${url}?ids=${encodeURIComponent(String(itemId))}`;
    const response = callSignedGet(fullUrl, secret);
    const data = JSON.parse(response);
    
    if (data.items && data.items.length > 0) {
      // 単一行の結果を反映
      updateSingleRowFromAiResult(sheet, activeRow, data.items[0]);
      SpreadsheetApp.getUi().alert(
        '最新情報取得完了',
        `対象: ${itemName}\n\n最新情報を取得してスプレッドシートに反映しました。`,
        SpreadsheetApp.getUi().ButtonSet.OK
      );
    } else {
      SpreadsheetApp.getUi().alert(
        '情報なし',
        `対象: ${itemName}\n\n取得可能な最新情報がありません。`,
        SpreadsheetApp.getUi().ButtonSet.OK
      );
    }
  } catch (error) {
    SpreadsheetApp.getUi().alert('エラー', `エラー: ${error.message}`, SpreadsheetApp.getUi().ButtonSet.OK);
  }
}

// ===== ボタン: 最新情報取得 (全体) =====
function fetchLatestInfo() {
  // 確認ダイアログ
  const result = SpreadsheetApp.getUi().alert(
    '最新情報を取得',
    '最新情報を取得を実行します\n\n対象: 全データ\n機能: AI補完結果をスプレッドシートに反映します\n\n⚠️ 注意事項:\n• 完了したAI補完結果のみが反映されます\n• 処理中または未完了のAI補完は反映されません\n• 反映には数秒〜数分かかる場合があります\n• 大量データの場合は処理時間が長くなる可能性があります\n• 通常は朝方（6:00 AM）に自動実行されます\n\n続行しますか？',
    SpreadsheetApp.getUi().ButtonSet.YES_NO
  );
  if (result !== SpreadsheetApp.getUi().Button.YES) {
    return;
  }
  
  const sheet = SpreadsheetApp.getActiveSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIndex = (name) => headers.indexOf(name) + 1;
  
  const colId = colIndex('ID');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert('データがありません');
    return;
  }
  
  const ids = sheet.getRange(2, colId, lastRow - 1, 1)
    .getValues()
    .flat()
    .filter(id => id)
    .join(',');
  
  const url = PropertiesService.getScriptProperties().getProperty(PROP_AI_RESULT_URL);
  const secret = PropertiesService.getScriptProperties().getProperty(PROP_WEBHOOK_SECRET);
  
  if (!url || !secret) {
    SpreadsheetApp.getUi().alert('AI_RESULT_URL または WEBHOOK_SECRET が未設定です');
    return;
  }
  
  try {
    const fullUrl = `${url}?ids=${encodeURIComponent(ids)}`;
    const response = callSignedGet(fullUrl, secret);
    const data = JSON.parse(response);
    
    // シート更新
    updateSheetFromAiResult(sheet, headers, data.items);
    SpreadsheetApp.getUi().alert(`最新情報を取得しました (${data.total}件)`);
  } catch (error) {
    SpreadsheetApp.getUi().alert(`エラー: ${error.message}`);
  }
}

function updateSheetFromAiResult(sheet, headers, items) {
  const colIndex = (name) => headers.indexOf(name) + 1;
  const colId = colIndex('ID');
  const colAiStatus = colIndex('AI補完状態');
  
  const colPubName = colIndex('公開商品名');
  const colPubMaker = colIndex('公開メーカー');
  const colPubCat = colIndex('公開カテゴリ');
  const colPubTags = colIndex('公開タグ');
  const colPubDesc = colIndex('公開説明文');
  const colPubAbv = colIndex('公開度数');
  const colPubImg = colIndex('公開画像URL');
  
  items.forEach(item => {
    const id = item.id;
    const row = findRowById(sheet, id, colId);
    if (!row) return;
    
    // AI補完状態を更新
    if (item.flags?.aiFailed) {
      sheet.getRange(row, colAiStatus).setValue(AI_STATUS.FAILED);
    } else if (item.flags?.aiCompleted) {
      sheet.getRange(row, colAiStatus).setValue(AI_STATUS.SUCCESS);
    } else if (item.flags?.aiRequested) {
      sheet.getRange(row, colAiStatus).setValue(AI_STATUS.REQUESTED);
    }
    
    // AI補完結果を優先公開列に反映
    const data = item.published || item.aiSuggested;
    if (data) {
      if (data.name) sheet.getRange(row, colPubName).setValue(data.name);
      if (data.maker) sheet.getRange(row, colPubMaker).setValue(data.maker);
      if (data.category) sheet.getRange(row, colPubCat).setValue(data.category);
      if (data.tags) sheet.getRange(row, colPubTags).setValue(data.tags);
      if (data.description) sheet.getRange(row, colPubDesc).setValue(data.description);
      if (data.alcoholVolume) {
        // 度数を文字列として設定（日付フォーマットを防ぐ）
        // 数値の場合はそのまま、文字列の場合は数値に変換してから%を付ける
        const abvValue = typeof data.alcoholVolume === 'number' 
          ? data.alcoholVolume 
          : parseFloat(String(data.alcoholVolume).replace(/[^0-9.]/g, ''));
        if (!isNaN(abvValue)) {
          sheet.getRange(row, colPubAbv).setValue(`${abvValue}%`);
        }
      }
      if (data.imageUrl) sheet.getRange(row, colPubImg).setValue(data.imageUrl);
    }
  });
}

function findRowById(sheet, id, colId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  
  const ids = sheet.getRange(2, colId, lastRow - 1, 1).getValues().flat();
  const idx = ids.findIndex(val => String(val) === String(id));
  return idx >= 0 ? idx + 2 : null;
}

// ===== Callback 受信（doPost） =====
function doPost(e) {
  if (!e || !e.postData) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'no postData' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  
  try {
    const payload = JSON.parse(e.postData.contents);
    
    if (payload.type === 'ai_completed') {
      handleAiCompleted(payload);
    }
    
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    Logger.log('doPost error: ' + error.message);
    return ContentService.createTextOutput(JSON.stringify({ error: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function handleAiCompleted(payload) {
  const sheet = SpreadsheetApp.getActiveSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIndex = (name) => headers.indexOf(name) + 1;
  
  const colId = colIndex('ID');
  const colAiStatus = colIndex('AI補完状態');
  
  const row = findRowById(sheet, payload.itemId, colId);
  if (!row) return;
  
  // AI補完状態を「成功」に設定
  sheet.getRange(row, colAiStatus).setValue(AI_STATUS.SUCCESS);
  
  if (payload.published) {
    const pub = payload.published;
    const colPubName = colIndex('公開商品名');
    const colPubMaker = colIndex('公開メーカー');
    const colPubCat = colIndex('公開カテゴリ');
    const colPubTags = colIndex('公開タグ');
    const colPubDesc = colIndex('公開説明文');
    const colPubAbv = colIndex('公開度数');
    const colPubImg = colIndex('公開画像URL');
    
    if (pub.name) sheet.getRange(row, colPubName).setValue(pub.name);
    if (pub.maker) sheet.getRange(row, colPubMaker).setValue(pub.maker);
    if (pub.category) sheet.getRange(row, colPubCat).setValue(pub.category);
    if (pub.tags) sheet.getRange(row, colPubTags).setValue(pub.tags);
    if (pub.description) sheet.getRange(row, colPubDesc).setValue(pub.description);
    if (pub.alcoholVolume) {
      // 度数を文字列として設定（日付フォーマットを防ぐ）
      const abvValue = typeof pub.alcoholVolume === 'number' 
        ? pub.alcoholVolume 
        : parseFloat(String(pub.alcoholVolume).replace(/[^0-9.]/g, ''));
      if (!isNaN(abvValue)) {
        sheet.getRange(row, colPubAbv).setValue(`${abvValue}%`);
      }
    }
    if (pub.imageUrl) sheet.getRange(row, colPubImg).setValue(pub.imageUrl);
  }
}

// ===== 署名付きAPI呼び出し =====
function callSignedApi(url, payload, secret) {
  const timestamp = Date.now();
  const body = JSON.stringify(payload);
  const message = timestamp + '.' + body;
  
  // messageとsecretをUTF-8バイト配列に変換
  const messageBytes = Utilities.newBlob(message).getBytes();
  const secretBytes = Utilities.newBlob(secret).getBytes();
  
  const signatureBytes = Utilities.computeHmacSha256Signature(messageBytes, secretBytes);
  const signature = signatureBytes.map(b => {
    // バイト値を0-255の範囲に正規化
    const normalized = b < 0 ? b + 256 : b;
    // 16進数に変換し、2桁にパディング
    return normalized.toString(16).padStart(2, '0');
  }).join('');
  
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-Timestamp': String(timestamp),
      'X-Signature': signature
    },
    payload: body,
    muteHttpExceptions: true
  };
  
  const response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() >= 400) {
    throw new Error(`HTTP ${response.getResponseCode()}: ${response.getContentText()}`);
  }
  return response.getContentText();
}

function callSignedGet(url, secret) {
  const timestamp = Date.now();
  const message = timestamp + '.GET';
  const signatureBytes = Utilities.computeHmacSha256Signature(message, secret);
  const signature = signatureBytes.map(b => {
    // バイト値を0-255の範囲に正規化
    const normalized = b < 0 ? b + 256 : b;
    // 16進数に変換し、2桁にパディング
    return normalized.toString(16).padStart(2, '0');
  }).join('');
  
  const options = {
    method: 'get',
    headers: {
      'X-Timestamp': String(timestamp),
      'X-Signature': signature
    },
    muteHttpExceptions: true
  };
  
  const response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() >= 400) {
    throw new Error(`HTTP ${response.getResponseCode()}: ${response.getContentText()}`);
  }
  return response.getContentText();
}

// ===== ユーティリティ関数 =====
function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

// UUID v4生成関数
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// 商品名取得関数（優先公開情報優先、なければ元情報）
function getItemName(sheet, row, headers) {
  const colIndex = (name) => headers.indexOf(name) + 1;
  
  // 優先公開商品名を確認
  const pubName = sheet.getRange(row, colIndex('公開商品名')).getValue();
  if (pubName && pubName.trim()) {
    return pubName.trim();
  }
  
  // 元情報の商品名を確認
  const sourceName = sheet.getRange(row, colIndex('商品名')).getValue();
  if (sourceName && sourceName.trim()) {
    return sourceName.trim();
  }
  
  return '商品名なし';
}

