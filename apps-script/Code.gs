/**
 * Bar Ease Hongo メニュー管理（GAS完結版）
 * 
 * 機能:
 * - doGet(): Webアプリで全データをJSON配信
 * - recommend(): Gemini 1.5 FlashでAIおすすめ（再ランク＋理由生成）
 * - 承認→反映: 時間トリガー（5分間隔）＋即時反映ボタン
 * - AI_Logs: レコメンド履歴記録
 */

// ===== 列定義 =====
const EXISTING_HEADERS = [
  '国', '製造会社', '販売会社', '蒸溜所', 'タイプ', '樽番号', '商品名', '備考',
  '熟成地', '樽種', '熟成期間', '現行', 'ピート感', '度数', '本数',
  '30ml', '15ml', '10ml'
];

const NEW_HEADERS = [
  '公開カテゴリ', '公開タイプ', '公開商品名', '公開メーカー', '公開タグ', '公開説明文',
  '公開度数',
  'AI補完状態', 'メニュー表示状態',
  'ID', '更新日時'
];

const PROTECTED_HEADERS = [
  'AI補完状態', 'メニュー表示状態', 'ID', '更新日時'
];

// AI補完状態の値
const AI_STATUS = {
  EMPTY: '',
  REQUESTED: '依頼済み',
  SUCCESS: '成功',
  FAILED: '失敗'
};

// メニュー表示状態の値
const PUBLISH_STATUS = {
  EMPTY: '',
  VISIBLE: 'メニューに表示',
  HIDDEN: '非表示'
};

// ===== Script Properties キー =====
const PROP_GEMINI_API_KEY = 'GEMINI_API_KEY';
const PROP_LAST_RATE_LIMIT = 'LAST_RATE_LIMIT'; // レート制限用

// ===== Webアプリ: doGet() =====
/**
 * Webアプリのエントリーポイント
 * 初回ロード時に全データをJSON形式で返すか、HTMLページを返す
 */
function doGet(e) {
  const path = e.parameter.path || '';
  
  if (path === 'api/menu') {
    // APIモード: JSONデータのみ返す
    return serveMenuJson();
  } else {
    // HTMLモード: index.htmlを返す
    return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('Bar Ease Hongo メニュー')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
}

/**
 * クライアント向けメニューデータ取得（google.script.run用）
 * CacheServiceを使って高速化
 */
function getMenuDataForClient() {
  try {
    Logger.log('[getMenuDataForClient] start');
    
    const cache = CacheService.getScriptCache();
    const cacheKey = 'menuData';
    
    // キャッシュから取得を試みる
    const cached = cache.get(cacheKey);
    if (cached) {
      Logger.log('[getMenuDataForClient] cache hit');
      const data = JSON.parse(cached);
      Logger.log('[getMenuDataForClient] returning ' + data.items.length + ' items from cache');
      return data;
    }
    
    // キャッシュがない場合はスプレッドシートから取得
    Logger.log('[getMenuDataForClient] cache miss, fetching from sheet');
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('メニュー');
    if (!sheet) {
      Logger.log('[getMenuDataForClient] sheet not found');
      return { items: [], total: 0, updatedAt: new Date().toISOString() };
    }
    
    Logger.log('[getMenuDataForClient] calling getMenuData');
    const data = getMenuData(sheet);
    Logger.log('[getMenuDataForClient] got ' + data.items.length + ' items');
    
    // 10分間キャッシュ（600秒）
    try {
      cache.put(cacheKey, JSON.stringify(data), 600);
      Logger.log('[getMenuDataForClient] cached for 600 seconds');
    } catch (cacheError) {
      Logger.log('[getMenuDataForClient] cache put failed: ' + cacheError.message);
      // キャッシュ失敗してもデータは返す
    }
    
    return data;
  } catch (error) {
    Logger.log('[getMenuDataForClient] error: ' + error.message);
    Logger.log('[getMenuDataForClient] stack: ' + error.stack);
    throw error; // エラーをクライアントに伝える
  }
}

/**
 * メニューキャッシュをクリア
 */
function clearMenuCache() {
  const cache = CacheService.getScriptCache();
  cache.remove('menuData');
  Logger.log('[clearMenuCache] menu cache cleared');
}

/**
 * メニューデータをJSON形式で返す
 */
function serveMenuJson() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('メニュー');
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'シートが見つかりません' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  
  const data = getMenuData(sheet);
  
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * シートからメニューデータを取得
 */
function getMenuData(sheet) {
  try {
    Logger.log('[getMenuData] start');
    
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    Logger.log('[getMenuData] headers count: ' + headers.length);
    
    const lastRow = sheet.getLastRow();
    Logger.log('[getMenuData] last row: ' + lastRow);
    
    if (lastRow < 2) {
      Logger.log('[getMenuData] no data rows');
      return { items: [], total: 0, updatedAt: new Date().toISOString() };
    }
    
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    Logger.log('[getMenuData] data rows fetched: ' + data.length);
    
    const colIndex = (name) => headers.indexOf(name);
  
  const items = data
    .filter(row => {
      const publishStatus = row[colIndex('メニュー表示状態')];
      const isVisible = publishStatus === PUBLISH_STATUS.VISIBLE;
      return isVisible;
    })
    .map(row => {
      const id = row[colIndex('ID')];
      const publishedName = row[colIndex('公開商品名')];
      const sourceName = row[colIndex('商品名')];
      const name = publishedName || sourceName || 'No name';
      
      const publishedMaker = row[colIndex('公開メーカー')];
      const sourceMaker = row[colIndex('製造会社')];
      const maker = publishedMaker || sourceMaker || '';
      
      const publishedCategory = row[colIndex('公開カテゴリ')];
      const category = publishedCategory || 'その他';
      
      const publishedType = row[colIndex('公開タイプ')];
      const sourceType = row[colIndex('タイプ')];
      const type = publishedType || sourceType || '';
      
      const publishedTags = row[colIndex('公開タグ')];
      const sourceTags = row[colIndex('ピート感')];
      const tagsStr = publishedTags || sourceTags || '';
      const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];
      
      const publishedDesc = row[colIndex('公開説明文')];
      const sourceDesc = row[colIndex('備考')];
      const description = publishedDesc || sourceDesc || '';
      
      const publishedAbv = row[colIndex('公開度数')];
      const sourceAbv = row[colIndex('度数')];
      const abvStr = String(publishedAbv || sourceAbv || '').replace(/[^0-9.]/g, '');
      const alcoholVolume = abvStr ? parseFloat(abvStr) : undefined;
      
      const price30ml = parseFloat(String(row[colIndex('30ml')] || '').replace(/[^0-9.]/g, '')) || undefined;
      const price15ml = parseFloat(String(row[colIndex('15ml')] || '').replace(/[^0-9.]/g, '')) || undefined;
      const price10ml = parseFloat(String(row[colIndex('10ml')] || '').replace(/[^0-9.]/g, '')) || undefined;
      
      return {
        id,
        name,
        maker,
        category,
        type,
        tags,
        description,
        alcoholVolume,
        price30ml,
        price15ml,
        price10ml,
        country: row[colIndex('国')] || '',
        distillery: row[colIndex('蒸溜所')] || '',
        caskType: row[colIndex('樽種')] || '',
        maturationPeriod: row[colIndex('熟成期間')] || '',
        updatedAt: row[colIndex('更新日時')] || ''
      };
    });
  
  Logger.log('[getMenuData] filtered items: ' + items.length);
  
  const result = {
    items: items,
    total: items.length,
    updatedAt: new Date().toISOString()
  };
  
  Logger.log('[getMenuData] complete, returning ' + result.total + ' items');
  return result;
  
  } catch (error) {
    Logger.log('[getMenuData] error: ' + error.message);
    Logger.log('[getMenuData] stack: ' + error.stack);
    throw error;
  }
}

// ===== AIおすすめ: recommend() =====
/**
 * クライアントから呼ばれるレコメンド関数
 * @param {Object} request - { prefs: {...}, candidates: [...] }
 * @return {Object} { error?: boolean, data?: {...}, message?: string }
 */
function recommend(request) {
  const startTime = Date.now();
  
  try {
    // 入力検証
    if (!request || !request.prefs || !request.candidates) {
      return {
        error: true,
        message: '入力が不正です',
        code: 'INVALID_INPUT'
      };
    }
    
    if (request.candidates.length === 0) {
      return {
        error: true,
        message: '候補が見つかりません',
        code: 'INVALID_INPUT'
      };
    }
    
    if (request.candidates.length > 20) {
      return {
        error: true,
        message: '候補が多すぎます（最大20件）',
        code: 'INVALID_INPUT'
      };
    }
    
    // レート制限チェック
    const rateLimitResult = checkRateLimit(request.prefs);
    if (rateLimitResult.limited) {
      return {
        error: true,
        message: rateLimitResult.message,
        code: 'RATE_LIMIT'
      };
    }
    
    // Gemini API呼び出し
    const apiKey = PropertiesService.getScriptProperties().getProperty(PROP_GEMINI_API_KEY);
    if (!apiKey) {
      return {
        error: true,
        message: 'GEMINI_API_KEYが設定されていません',
        code: 'MODEL_ERROR'
      };
    }
    
    const geminiResponse = callGeminiAPI_(apiKey, request);
    const latencyMs = Date.now() - startTime;
    
    // ログ記録
    logRecommendation(request, geminiResponse, latencyMs);
    
    // レート制限記録
    updateRateLimit(request.prefs);
    
    return {
      error: false,
      data: {
        items: geminiResponse.items || [],
        note: geminiResponse.note,
        meta: {
          model: 'gemini-2.0-flash-exp',
          latencyMs,
          tokenUsage: geminiResponse.tokenUsage
        }
      }
    };
    
  } catch (error) {
    Logger.log('[recommend] error: ' + error.message);
    return {
      error: true,
      message: 'エラーが発生しました: ' + error.message,
      code: 'MODEL_ERROR'
    };
  }
}

/**
 * Gemini API呼び出し（プライベート関数）
 */
function callGeminiAPI_(apiKey, request) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=' + apiKey;
  
  const prompt = buildRecommendPrompt_(request);
  
  const payload = {
    contents: [{
      parts: [{
        text: prompt
      }]
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 480,
      topP: 0.95,
      topK: 40
    }
  };
  
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  const response = UrlFetchApp.fetch(url, options);
  const statusCode = response.getResponseCode();
  const responseText = response.getContentText();
  
  if (statusCode !== 200) {
    Logger.log('[callGeminiAPI] error: ' + statusCode + ' ' + responseText);
    throw new Error('Gemini API error: ' + statusCode);
  }
  
  Logger.log('[callGeminiAPI] response: ' + responseText);
  
  const result = JSON.parse(responseText);
  
  // レスポンス解析
  if (!result.candidates || result.candidates.length === 0) {
    throw new Error('Gemini API returned no candidates. Response: ' + responseText.substring(0, 500));
  }
  
  const candidate = result.candidates[0];
  
  // Gemini 2.5の新しいレスポンス構造に対応
  let text = '';
  
  if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
    // 通常の構造
    text = candidate.content.parts[0].text;
  } else if (candidate.text) {
    // 別の構造（textフィールドが直接ある場合）
    text = candidate.text;
  } else if (candidate.output) {
    // outputフィールドがある場合
    text = candidate.output;
  } else {
    Logger.log('[callGeminiAPI] Full response: ' + responseText);
    throw new Error('テキストが見つかりません。finishReason: ' + (candidate.finishReason || 'unknown') + '. レスポンス全体はログを確認してください。');
  }
  
  if (!text || text.trim().length === 0) {
    throw new Error('空のテキストが返されました。finishReason: ' + (candidate.finishReason || 'unknown'));
  }
  
  // JSON抽出
  let jsonData;
  try {
    jsonData = extractJSON_(text);
  } catch (error) {
    Logger.log('[callGeminiAPI] JSON parse error: ' + error.message);
    // フォールバック: noteに生テキストを返す
    return {
      items: [],
      note: 'AIからの応答を解析できませんでした: ' + text.substring(0, 200)
    };
  }
  
  // トークン使用量（あれば）
  const tokenUsage = result.usageMetadata ? {
    input: result.usageMetadata.promptTokenCount,
    output: result.usageMetadata.candidatesTokenCount
  } : undefined;
  
  return {
    items: jsonData.items || [],
    note: jsonData.note,
    tokenUsage
  };
}

/**
 * レコメンドプロンプト生成
 */
function buildRecommendPrompt_(request) {
  const { prefs, candidates } = request;
  
  let prefsText = '';
  if (prefs.base) prefsText += `ベース: ${prefs.base}\n`;
  if (prefs.taste) prefsText += `味わい: ${prefs.taste}\n`;
  if (prefs.maxPrice) prefsText += `最大価格: ${prefs.maxPrice}円\n`;
  if (prefs.memo) prefsText += `その他: ${prefs.memo}\n`;
  
  if (!prefsText) {
    prefsText = '特になし（幅広く提案してください）';
  }
  
  const candidatesText = candidates.map((c, i) => {
    let line = `${i + 1}. [ID: ${c.id}] ${c.name}`;
    if (c.maker) line += ` (${c.maker})`;
    if (c.tags && c.tags.length > 0) line += ` [タグ: ${c.tags.join(', ')}]`;
    if (c.price) line += ` ¥${c.price}`;
    if (c.abv) line += ` ${c.abv}%`;
    return line;
  }).join('\n');
  
  return `あなたはプロのバーテンダーです。お客様の好みに合わせて、以下の候補から最適な3つのお酒をおすすめしてください。

## お客様の好み
${prefsText}

## 候補リスト
${candidatesText}

## 指示
1. 上記の候補から、お客様の好みに最も合う3つを選んでください
2. 各おすすめについて、80〜120文字程度の理由を日本語で書いてください
3. 理由は具体的で、お客様の好みとの関連性を明確にしてください
4. 必ず以下のJSON形式で返してください（他のテキストは含めないでください）

\`\`\`json
{
  "items": [
    {
      "id": "候補のID",
      "reason": "おすすめ理由（80〜120文字）",
      "serve": "提供方法（オプション、例: ストレート、ロック等）"
    }
  ],
  "note": "全体的な補足メッセージ（オプション）"
}
\`\`\`

必ずJSON形式のみで返してください。`;
}

/**
 * テキストからJSON抽出
 */
function extractJSON_(text) {
  // ```json ... ``` を探す
  let match = text.match(/```json\s*([\s\S]+?)```/i);
  if (match) {
    return JSON.parse(match[1].trim());
  }
  
  // ``` ... ``` を探す
  match = text.match(/```\s*([\s\S]+?)```/i);
  if (match) {
    return JSON.parse(match[1].trim());
  }
  
  // { で始まる部分を探す
  const jsonStart = text.indexOf('{');
  if (jsonStart !== -1) {
    return JSON.parse(text.substring(jsonStart));
  }
  
  throw new Error('JSON not found in response');
}

/**
 * レート制限チェック
 * 同じ嗜好で短時間に何度も呼ばれるのを防ぐ
 */
function checkRateLimit(prefs) {
  const props = PropertiesService.getScriptProperties();
  const lastRateLimit = props.getProperty(PROP_LAST_RATE_LIMIT);
  
  if (!lastRateLimit) {
    return { limited: false };
  }
  
  const lastData = JSON.parse(lastRateLimit);
  const now = Date.now();
  const elapsed = now - lastData.timestamp;
  
  // 10秒以内の同一嗜好は制限
  if (elapsed < 10000) {
    const lastPrefs = lastData.prefs;
    if (JSON.stringify(prefs) === JSON.stringify(lastPrefs)) {
      return {
        limited: true,
        message: '短時間に同じ条件で何度もリクエストすることはできません'
      };
    }
  }
  
  return { limited: false };
}

/**
 * レート制限記録
 */
function updateRateLimit(prefs) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_LAST_RATE_LIMIT, JSON.stringify({
    prefs,
    timestamp: Date.now()
  }));
}

/**
 * レコメンドログ記録
 */
function logRecommendation(request, response, latencyMs) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let logSheet = ss.getSheetByName('AI_Logs');
  
  if (!logSheet) {
    logSheet = ss.insertSheet('AI_Logs');
    logSheet.appendRow(['タイムスタンプ', 'ベース', '味わい', '最大価格', 'メモ', '候補数', 'おすすめ件数', 'レイテンシ(ms)', '応答']);
  }
  
  const timestamp = new Date().toISOString();
  const prefs = request.prefs || {};
  const base = prefs.base || '';
  const taste = prefs.taste || '';
  const maxPrice = prefs.maxPrice || '';
  const memo = prefs.memo || '';
  const candidatesCount = request.candidates ? request.candidates.length : 0;
  const itemsCount = response.items ? response.items.length : 0;
  const responseText = JSON.stringify(response);
  
  logSheet.appendRow([timestamp, base, taste, maxPrice, memo, candidatesCount, itemsCount, latencyMs, responseText]);
}

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
    if (idx === -1) throw new Error(name + ' 列が見つかりません');
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
  
  SpreadsheetApp.flush();
  Logger.log('セットアップ完了');
  SpreadsheetApp.getUi().alert('セットアップ完了', 'メニューシートの初期設定が完了しました。', SpreadsheetApp.getUi().ButtonSet.OK);
}

function protectColumns(sheet, headers, names) {
  const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  names.forEach(name => {
    const idx = headers.indexOf(name);
    if (idx === -1) return;
    const column = idx + 1;
    const range = sheet.getRange(1, column, sheet.getMaxRows());
    
    protections
      .filter(p => p.getDescription() === (name + ' 列保護'))
      .forEach(p => p.remove());
    
    const protection = range.protect();
    protection.setDescription(name + ' 列保護');
    protection.setWarningOnly(true);
  });
}

// ===== カスタムメニュー =====
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Bar Ease Hongo')
    .addItem('AI補完を実行 (1行のみ)', 'requestAiCompletion')
    .addSeparator()
    .addItem('メニューに表示', 'showInMenu')
    .addItem('メニューから非表示', 'hideFromMenu')
    .addSeparator()
    .addItem('IDを生成 (1行のみ)', 'generateIdForRow')
    .addItem('🔄 キャッシュをクリア', 'clearMenuCache')
    .addSeparator()
    .addItem('🔍 データ確認（デバッグ）', 'debugMenuData')
    .addItem('🔌 Gemini API接続テスト', 'testGeminiAPI')
    .addItem('初期設定', 'setupMenuSheet')
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
  
  const colIdStart = colIndex('公開カテゴリ');
  const colIdEnd = colIndex('公開度数');
  const colPublishStatus = colIndex('メニュー表示状態');
  const colId = colIndex('ID');
  const colUpdated = colIndex('更新日時');
  
  // 優先公開列が編集されたら「メニュー表示状態」をクリア＋キャッシュクリア
  if (col >= colIdStart && col <= colIdEnd && colPublishStatus > 0) {
    sheet.getRange(row, colPublishStatus).setValue('');
    clearMenuCache();
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

// ===== ボタン: AI補完を実行 =====
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
  let confirmMessage = 'AI補完を実行します\n\n対象: ' + itemName + ' (' + activeRow + '行目)\n機能: 欠損値や間違った情報をAIで補完・修正します\n\n⚠️ 注意事項:\n• 即座にAI補完を実行し、結果を反映します\n• 処理には10〜30秒かかる場合があります\n• インターネット接続が必要です\n\n続行しますか？';
  
  // 複数行選択時の警告を追記
  if (activeRow !== lastRow) {
    confirmMessage = 'AI補完を実行します\n\n⚠️ 複数行が選択されています\n選択範囲: ' + activeRow + '行目〜' + lastRow + '行目\n' + activeRow + '行目のみ処理されます\n\n対象: ' + itemName + ' (' + activeRow + '行目)\n機能: 欠損値や間違った情報をAIで補完・修正します\n\n⚠️ 注意事項:\n• 即座にAI補完を実行し、結果を反映します\n• 処理には10〜30秒かかる場合があります\n• インターネット接続が必要です\n\n続行しますか？';
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
  const colAiStatus = colIndex('AI補完状態');
  
  // source データ収集
  const source = collectSourceData(sheet, activeRow, headers);
  
  // Gemini API Key取得
  const apiKey = PropertiesService.getScriptProperties().getProperty(PROP_GEMINI_API_KEY);
  if (!apiKey) {
    SpreadsheetApp.getUi().alert('エラー', 'GEMINI_API_KEYが設定されていません', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
  // AI補完状態を「依頼済み」に
  sheet.getRange(activeRow, colAiStatus).setValue(AI_STATUS.REQUESTED);
  SpreadsheetApp.flush();
  
  try {
    // AI補完実行
    const aiResult = callGeminiForCompletion_(apiKey, source);
    
    // 公開列に反映
    updatePublishedColumns(sheet, activeRow, headers, aiResult);
    
    // AI補完状態を「成功」に
    sheet.getRange(activeRow, colAiStatus).setValue(AI_STATUS.SUCCESS);
    
    // キャッシュクリア（次回アクセス時に最新データを取得）
    clearMenuCache();
    
    SpreadsheetApp.getUi().alert(
      'AI補完完了',
      '対象: ' + itemName + '\n\nAI補完が完了し、公開列に反映しました。\n\n※ メニューに表示するには「メニューに表示」ボタンを押してください。',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (error) {
    // エラー時は「失敗」に設定
    sheet.getRange(activeRow, colAiStatus).setValue(AI_STATUS.FAILED);
    SpreadsheetApp.getUi().alert('エラー', 'エラー: ' + error.message, SpreadsheetApp.getUi().ButtonSet.OK);
  }
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
  const colIndex = (name) => headers.indexOf(name) + 1;
  
  // 処理対象の行数
  const rowCount = lastRow - activeRow + 1;
  
  // 確認ダイアログ
  let actionName = '';
  let actionDescription = '';
  
  if (newPublishStatus === PUBLISH_STATUS.VISIBLE) {
    actionName = 'メニューに表示';
    actionDescription = 'Webアプリのメニューに表示します';
  } else if (newPublishStatus === PUBLISH_STATUS.HIDDEN) {
    actionName = 'メニューから非表示';
    actionDescription = 'Webアプリのメニューから非表示にします';
  }
  
  let confirmMessage = '';
  
  if (rowCount === 1) {
    const itemName = getItemName(sheet, activeRow, headers);
    confirmMessage = actionName + 'を実行します\n\n対象: ' + itemName + ' (' + activeRow + '行目)\n機能: ' + actionDescription + '\n\n続行しますか？';
  } else {
    confirmMessage = actionName + 'を実行します\n\n対象: ' + rowCount + '行（' + activeRow + '行目〜' + lastRow + '行目）\n機能: ' + actionDescription + '\n\n続行しますか？';
  }
  
  const result = SpreadsheetApp.getUi().alert(
    actionName,
    confirmMessage,
    SpreadsheetApp.getUi().ButtonSet.YES_NO
  );
  if (result !== SpreadsheetApp.getUi().Button.YES) {
    return;
  }
  
  const colPublishStatus = colIndex('メニュー表示状態');
  
  // 選択範囲の全行に対してメニュー表示状態を設定
  let processedCount = 0;
  const itemNames = [];
  
  for (let row = activeRow; row <= lastRow; row++) {
    if (row <= 1) continue; // ヘッダー行はスキップ
    
    sheet.getRange(row, colPublishStatus).setValue(newPublishStatus);
    processedCount++;
    
    // 最初の3件まで商品名を記録
    if (itemNames.length < 3) {
      itemNames.push(getItemName(sheet, row, headers));
    }
  }
  
  // キャッシュクリア（次回アクセス時に最新データを取得）
  clearMenuCache();
  
  // 完了メッセージ
  let message = '';
  if (processedCount === 1) {
    message = newPublishStatus === PUBLISH_STATUS.VISIBLE
      ? 'メニューに表示しました\n\n対象: ' + itemNames[0] + '\n\n📱 Webアプリで確認するには、ブラウザをリロード（F5）してください。'
      : 'メニューから非表示にしました\n\n対象: ' + itemNames[0] + '\n\n📱 Webアプリで確認するには、ブラウザをリロード（F5）してください。';
  } else {
    const previewItems = itemNames.join('、');
    const moreText = processedCount > 3 ? '、他' + (processedCount - 3) + '件' : '';
    message = newPublishStatus === PUBLISH_STATUS.VISIBLE
      ? 'メニューに表示しました\n\n対象: ' + processedCount + '行\n（' + previewItems + moreText + '）\n\n📱 Webアプリで確認するには、ブラウザをリロード（F5）してください。'
      : 'メニューから非表示にしました\n\n対象: ' + processedCount + '行\n（' + previewItems + moreText + '）\n\n📱 Webアプリで確認するには、ブラウザをリロード（F5）してください。';
  }
  
  SpreadsheetApp.getUi().alert(message);
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
  let confirmMessage = 'IDを生成します\n\n対象: ' + itemName + ' (' + activeRow + '行目)\n機能: 選択行にUUIDを生成・設定します\n\n続行しますか？';
  
  // 複数行選択時の警告を追記
  if (activeRow !== lastRow) {
    confirmMessage = 'IDを生成します\n\n⚠️ 複数行が選択されています\n選択範囲: ' + activeRow + '行目〜' + lastRow + '行目\n' + activeRow + '行目のみ処理されます\n\n対象: ' + itemName + ' (' + activeRow + '行目)\n機能: 選択行にUUIDを生成・設定します\n\n続行しますか？';
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
      '現在のID: ' + currentId + '\n\n新しいUUIDで上書きしますか？',
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
    '対象: ' + itemName + '\n\nUUIDを生成して' + activeRow + '行目に設定しました。',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ===== ボタン: 設定確認 =====
function checkSettings() {
  const props = PropertiesService.getScriptProperties();
  const geminiApiKey = props.getProperty(PROP_GEMINI_API_KEY);
  
  // キャッシュの状態確認
  const cache = CacheService.getScriptCache();
  const cached = cache.get('menuData');
  const cacheStatus = cached ? '✓ 有効（10分間）' : '✗ なし';
  
  // AI_Logsから今日の使用統計を取得
  const stats = getAiUsageStats();
  
  const message = '設定状況:\n\n' +
    '【API設定】\n' +
    '• GEMINI_API_KEY: ' + (geminiApiKey ? '✓ 設定済み' : '✗ 未設定') + '\n' +
    '• 使用モデル: gemini-2.0-flash-exp\n\n' +
    '【キャッシュ】\n' +
    '• メニューデータ: ' + cacheStatus + '\n\n' +
    '【AI使用状況（本日）】\n' +
    '• AIおすすめリクエスト: ' + stats.todayCount + '回\n' +
    '• 平均レイテンシ: ' + stats.avgLatency + 'ms\n\n' +
    '【無料枠の制限】\n' +
    '• 1日: 1,500 requests\n' +
    '• 1分: 15 requests\n' +
    '• トークン: 1M tokens/分\n\n' +
    '💡 現在の使用量は十分に余裕があります。\n\n' +
    '未設定の項目がある場合は、Apps Script エディタで\n' +
    '「プロジェクトの設定」→「スクリプト プロパティ」から設定してください。\n\n' +
    '設定例:\n' +
    '• GEMINI_API_KEY: your-gemini-api-key';
  
  SpreadsheetApp.getUi().alert(message);
}

/**
 * AI使用統計を取得
 */
function getAiUsageStats() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName('AI_Logs');
  
  if (!logSheet) {
    return { todayCount: 0, avgLatency: 0 };
  }
  
  const lastRow = logSheet.getLastRow();
  if (lastRow <= 1) {
    return { todayCount: 0, avgLatency: 0 };
  }
  
  const data = logSheet.getRange(2, 1, lastRow - 1, 8).getValues();
  
  // 今日の日付
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  let todayCount = 0;
  let totalLatency = 0;
  
  data.forEach(row => {
    const timestamp = new Date(row[0]); // タイムスタンプ列
    const latency = row[7]; // レイテンシ列
    
    if (timestamp >= today) {
      todayCount++;
      if (latency && !isNaN(latency)) {
        totalLatency += latency;
      }
    }
  });
  
  const avgLatency = todayCount > 0 ? Math.round(totalLatency / todayCount) : 0;
  
  return { todayCount, avgLatency };
}

// ===== デバッグ: Gemini API接続テスト =====
function testGeminiAPI() {
  const apiKey = PropertiesService.getScriptProperties().getProperty(PROP_GEMINI_API_KEY);
  if (!apiKey) {
    SpreadsheetApp.getUi().alert('エラー', 'GEMINI_API_KEYが設定されていません', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
  let results = 'Gemini API接続テスト結果:\n\n';
  
  // 1. モデルリスト取得
  try {
    const listUrl = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey;
    const listResponse = UrlFetchApp.fetch(listUrl, { muteHttpExceptions: true });
    const listStatusCode = listResponse.getResponseCode();
    
    if (listStatusCode === 200) {
      results += '✓ API接続: OK\n\n';
      const listData = JSON.parse(listResponse.getContentText());
      
      if (listData.models && listData.models.length > 0) {
        results += '利用可能なモデル:\n';
        const generateModels = listData.models
          .filter(m => m.name && m.name.indexOf('gemini') !== -1 && m.supportedGenerationMethods && m.supportedGenerationMethods.indexOf('generateContent') !== -1)
          .slice(0, 10); // 最初の10個まで
        
        generateModels.forEach(m => {
          const modelName = m.name.replace('models/', '');
          results += '  • ' + modelName + '\n';
        });
        
        if (generateModels.length > 0) {
          results += '\n推奨: ' + generateModels[0].name.replace('models/', '');
        }
      } else {
        results += '⚠️ モデルリストが空です\n';
      }
    } else {
      results += '✗ API接続エラー: ' + listStatusCode + '\n';
      results += 'レスポンス: ' + listResponse.getContentText().substring(0, 200);
    }
  } catch (error) {
    results += '✗ 例外エラー: ' + error.message + '\n\n';
    results += '確認事項:\n';
    results += '1. APIキーが正しく設定されているか\n';
    results += '2. Google AI Studioで取得したキーか\n';
    results += '3. ネットワーク接続があるか';
  }
  
  SpreadsheetApp.getUi().alert('API接続テスト', results, SpreadsheetApp.getUi().ButtonSet.OK);
}

// ===== デバッグ: データ確認 =====
function debugMenuData() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('メニュー');
  if (!sheet) {
    SpreadsheetApp.getUi().alert('エラー', 'メニューシートが見つかりません', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
  const activeRow = sheet.getActiveRange().getRow();
  if (activeRow <= 1) {
    SpreadsheetApp.getUi().alert('エラー', 'データ行を選択してください', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIndex = (name) => headers.indexOf(name);
  const row = sheet.getRange(activeRow, 1, 1, sheet.getLastColumn()).getValues()[0];
  
  const id = row[colIndex('ID')];
  const publishStatus = row[colIndex('メニュー表示状態')];
  const name = row[colIndex('公開商品名')] || row[colIndex('商品名')];
  
  const message = 'デバッグ情報:\n\n' +
    '行番号: ' + activeRow + '\n' +
    'ID: ' + (id || '(未設定)') + '\n' +
    '商品名: ' + (name || '(未設定)') + '\n' +
    'メニュー表示状態: [' + (publishStatus || '(空)') + ']\n' +
    '期待値: [' + PUBLISH_STATUS.VISIBLE + ']\n' +
    '一致: ' + (publishStatus === PUBLISH_STATUS.VISIBLE ? '✓ はい' : '✗ いいえ') + '\n\n' +
    '※ [ ] 内の値を確認してください。前後に空白がある場合は、セルを編集し直してください。';
  
  SpreadsheetApp.getUi().alert('デバッグ情報', message, SpreadsheetApp.getUi().ButtonSet.OK);
}

// ===== AI補完用ヘルパー関数 =====
/**
 * 元データを収集
 */
function collectSourceData(sheet, row, headers) {
  const colIndex = (name) => headers.indexOf(name) + 1;
  
  return {
    name: sheet.getRange(row, colIndex('商品名')).getValue() || '',
    maker: sheet.getRange(row, colIndex('製造会社')).getValue() || '',
    category: '',
    tags: sheet.getRange(row, colIndex('ピート感')).getValue() || '',
    description: '',
    alcoholVolume: (function() {
      const value = sheet.getRange(row, colIndex('度数')).getValue();
      if (!value) return '';
      const numeric = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.]/g, ''));
      return isNaN(numeric) ? '' : numeric;
    })(),
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

/**
 * Gemini APIでAI補完実行
 */
function callGeminiForCompletion_(apiKey, source) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=' + apiKey;
  
  const prompt = buildCompletionPrompt_(source);
  
  const payload = {
    contents: [{
      parts: [{
        text: prompt
      }]
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 2048,
      topP: 0.95,
      topK: 40
    }
  };
  
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  const response = UrlFetchApp.fetch(url, options);
  const statusCode = response.getResponseCode();
  const responseText = response.getContentText();
  
  if (statusCode !== 200) {
    Logger.log('[callGeminiForCompletion] error: ' + statusCode + ' ' + responseText);
    throw new Error('Gemini API error: ' + statusCode);
  }
  
  Logger.log('[callGeminiForCompletion] response: ' + responseText);
  
  const result = JSON.parse(responseText);
  
  // レスポンス構造をログ出力
  Logger.log('[callGeminiForCompletion] result structure: ' + JSON.stringify({
    hasCandidates: !!result.candidates,
    candidatesLength: result.candidates ? result.candidates.length : 0,
    hasContent: result.candidates && result.candidates.length > 0 && !!result.candidates[0].content,
    hasParts: result.candidates && result.candidates.length > 0 && result.candidates[0].content && !!result.candidates[0].content.parts
  }));
  
  if (!result.candidates || result.candidates.length === 0) {
    throw new Error('Gemini API returned no candidates. Response: ' + responseText.substring(0, 500));
  }
  
  const candidate = result.candidates[0];
  
  // Gemini 2.5の新しいレスポンス構造に対応
  let text = '';
  
  if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
    // 通常の構造
    text = candidate.content.parts[0].text;
  } else if (candidate.text) {
    // 別の構造（textフィールドが直接ある場合）
    text = candidate.text;
  } else if (candidate.output) {
    // outputフィールドがある場合
    text = candidate.output;
  } else {
    Logger.log('[callGeminiForCompletion] Full response: ' + responseText);
    throw new Error('テキストが見つかりません。finishReason: ' + (candidate.finishReason || 'unknown') + '. レスポンス全体はログを確認してください。');
  }
  
  if (!text || text.trim().length === 0) {
    throw new Error('空のテキストが返されました。finishReason: ' + (candidate.finishReason || 'unknown'));
  }
  
  return extractJSON_(text);
}

/**
 * AI補完プロンプト生成
 */
function buildCompletionPrompt_(source) {
  return '以下の「お酒（酒類）アイテム」の情報について、公式情報（メーカー公式サイト、正規輸入元、公式資料）を最優先に、欠損値または明らかに間違っている情報のみを補完・修正してください。\n\n' +
    '補完対象:\n' +
    '- 空欄・未入力のフィールド\n' +
    '- 明らかに間違っている情報（例：存在しないメーカー名、不整合な度数、誤った国名など）\n' +
    '- 整合性のない情報（例：商品名とメーカーが一致しない、不可能な熟成年数など）\n\n' +
    '既存値が妥当で正確な場合は変更せず、欠損または誤りがあるフィールドのみを返してください。\n\n' +
    'JSONスキーマ（補完が必要なフィールドのみ返す）:\n' +
    '{\n' +
    '  "name": "商品名",\n' +
    '  "maker": "メーカー名（正規表記）",\n' +
    '  "category": "カテゴリ（酒種。例：ウイスキー／ラム／ジン／ビール／ワイン 等）",\n' +
    '  "type": "タイプ（酒種内の分類。例：ウイスキーならシングルモルト・ブレンデッド、ラムならダーク・ホワイト 等）",\n' +
    '  "description": "50〜80文字程度の説明（宣伝文句ではなく中立・簡潔）",\n' +
    '  "tags": ["3〜5個の味わい・特徴タグ（必ず日本語で。例：スモーキー、フルーティー、華やか、滑らか、ピーティー、バニラ、スパイシー）"],\n' +
    '  "country": "生産国（必ず和名で統一。例：スコットランド、アイルランド、アメリカ、日本）",\n' +
    '  "maturationPeriod": "熟成年数／期間（該当しない場合は \'N/A\' 等）",\n' +
    '  "caskType": "樽種／熟成容器（該当しない場合は \'N/A\' 等）",\n' +
    '  "alcoholVolume": "度数 (整数値、例: 43, 43.5)"\n' +
    '}\n\n' +
    '前提・ポリシー:\n' +
    '- 公式情報を最優先。非公式情報しか見つからない場合は一般に妥当な定説を用いる。\n' +
    '- 事実と推定が混同しないよう、description は断定的表現を避け簡潔に。\n' +
    '- 既存値が正確な場合は変更しない。\n' +
    '- **tagsは必ず日本語で記述してください。カタカナ語も含めて、すべて日本語で統一してください。**\n' +
    '- 必ず有効なJSONのみを返してください。説明文やコメントは一切含めないでください。\n\n' +
    '重要: レスポンスは必ず以下の形式で返してください:\n' +
    '```json\n' +
    '{\n' +
    '  "name": "商品名",\n' +
    '  "maker": "メーカー名",\n' +
    '  ...\n' +
    '}\n' +
    '```\n\n' +
    '既存の値:\n' +
    JSON.stringify(source, null, 2);
}

/**
 * AI補完結果を公開列に反映
 */
function updatePublishedColumns(sheet, row, headers, aiResult) {
  const colIndex = (name) => headers.indexOf(name) + 1;
  
  if (aiResult.name) {
    sheet.getRange(row, colIndex('公開商品名')).setValue(aiResult.name);
  }
  if (aiResult.maker) {
    sheet.getRange(row, colIndex('公開メーカー')).setValue(aiResult.maker);
  }
  if (aiResult.category) {
    sheet.getRange(row, colIndex('公開カテゴリ')).setValue(aiResult.category);
  }
  if (aiResult.type) {
    sheet.getRange(row, colIndex('公開タイプ')).setValue(aiResult.type);
  }
  if (aiResult.tags) {
    const tagsStr = Array.isArray(aiResult.tags) ? aiResult.tags.join(', ') : aiResult.tags;
    sheet.getRange(row, colIndex('公開タグ')).setValue(tagsStr);
  }
  if (aiResult.description) {
    sheet.getRange(row, colIndex('公開説明文')).setValue(aiResult.description);
  }
  if (aiResult.alcoholVolume) {
    const abvValue = typeof aiResult.alcoholVolume === 'number' 
      ? aiResult.alcoholVolume 
      : parseFloat(String(aiResult.alcoholVolume).replace(/[^0-9.]/g, ''));
    if (!isNaN(abvValue)) {
      sheet.getRange(row, colIndex('公開度数')).setValue(abvValue + '%');
    }
  }
}

// ===== ユーティリティ関数 =====
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
  if (pubName && String(pubName).trim()) {
    return String(pubName).trim();
  }
  
  // 元情報の商品名を確認
  const sourceName = sheet.getRange(row, colIndex('商品名')).getValue();
  if (sourceName && String(sourceName).trim()) {
    return String(sourceName).trim();
  }
  
  return '商品名なし';
}

