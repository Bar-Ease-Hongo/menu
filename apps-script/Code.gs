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
  '公開カテゴリ', '公開国', '公開メーカー', '公開蒸溜所', '公開タイプ', '公開商品名', 
  '公開説明文', '公開樽種', '公開熟成期間', '公開度数', '公開タグ',
  'AI補完状態', 'メニュー表示状態'
];

const PROTECTED_HEADERS = [
  'AI補完状態', 'メニュー表示状態'
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
 * クライアント向けカテゴリ一覧取得（google.script.run用）
 * CacheServiceを使って高速化
 */
function getCategoriesForClient() {
  try {
    Logger.log('[getCategoriesForClient] start');
    
    const cache = CacheService.getScriptCache();
    const cacheKey = 'categories';
    
    // キャッシュから取得を試みる
    const cached = cache.get(cacheKey);
    if (cached) {
      Logger.log('[getCategoriesForClient] cache hit');
      const data = JSON.parse(cached);
      Logger.log('[getCategoriesForClient] returning ' + data.categories.length + ' categories from cache');
      return data;
    }
    
    // キャッシュがない場合はスプレッドシートから取得
    Logger.log('[getCategoriesForClient] cache miss, fetching from sheet');
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('メニュー');
    if (!sheet) {
      Logger.log('[getCategoriesForClient] sheet not found');
      return { categories: [], updatedAt: new Date().toISOString() };
    }
    
    Logger.log('[getCategoriesForClient] calling getCategories');
    const data = getCategories(sheet);
    Logger.log('[getCategoriesForClient] got ' + data.categories.length + ' categories');
    
    // 10分間キャッシュ（600秒）
    try {
      cache.put(cacheKey, JSON.stringify(data), 600);
      Logger.log('[getCategoriesForClient] cached for 600 seconds');
    } catch (cacheError) {
      Logger.log('[getCategoriesForClient] cache put failed: ' + cacheError.message);
      // キャッシュ失敗してもデータは返す
    }
    
    return data;
  } catch (error) {
    Logger.log('[getCategoriesForClient] error: ' + error.message);
    Logger.log('[getCategoriesForClient] stack: ' + error.stack);
    throw error;
  }
}

/**
 * クライアント向けメニューデータ取得（google.script.run用）
 * CacheServiceを使って高速化
 * @param {Object} options - { category?: string }
 */
function getMenuDataForClient(options) {
  try {
    Logger.log('[getMenuDataForClient] start');
    
    options = options || {};
    const category = options.category || null;
    
    const cache = CacheService.getScriptCache();
    const cacheKey = category ? 'menuData_' + category : 'menuData';
    
    // キャッシュから取得を試みる
    const cached = cache.get(cacheKey);
    if (cached) {
      Logger.log('[getMenuDataForClient] cache hit for key: ' + cacheKey);
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
    
    Logger.log('[getMenuDataForClient] calling getMenuData with category: ' + category);
    const data = getMenuData(sheet, category);
    Logger.log('[getMenuDataForClient] got ' + data.items.length + ' items');
    
    // 10分間キャッシュ（600秒）
    try {
      cache.put(cacheKey, JSON.stringify(data), 600);
      Logger.log('[getMenuDataForClient] cached for 600 seconds with key: ' + cacheKey);
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
 * メニューキャッシュをクリア（タグキャッシュも含む）
 */
function clearMenuCache() {
  const cache = CacheService.getScriptCache();
  
  // カテゴリキャッシュをクリア
  cache.remove('categories');
  
  // メニューデータキャッシュをクリア（全体とカテゴリ別）
  cache.remove('menuData');
  
  // タグキャッシュをクリア（カテゴリ別）
  // カテゴリ一覧を取得してタグキャッシュをクリア
  try {
    const categories = getCategoriesForClient().categories || [];
    categories.forEach(category => {
      const menuDataKey = 'menuData_' + category;
      const tagsKey = 'tags_' + category;
      cache.remove(menuDataKey);
      cache.remove(tagsKey);
      Logger.log('[clearMenuCache] cleared cache for category: ' + category);
    });
  } catch (error) {
    Logger.log('[clearMenuCache] error clearing category caches: ' + error.message);
  }
  
  Logger.log('[clearMenuCache] menu, tags and category cache cleared');
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
 * シートからカテゴリ一覧を取得
 * @param {Sheet} sheet - メニューシート
 * @return {Object} { categories: string[], updatedAt: string }
 */
function getCategories(sheet) {
  try {
    Logger.log('[getCategories] start');
    
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const lastRow = sheet.getLastRow();
    
    if (lastRow < 2) {
      Logger.log('[getCategories] no data rows');
      return { categories: [], updatedAt: new Date().toISOString() };
    }
    
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const colIndex = (name) => headers.indexOf(name);
    
    const categorySet = new Set();
    
    data.forEach(row => {
      const publishStatus = row[colIndex('メニュー表示状態')];
      if (publishStatus !== PUBLISH_STATUS.VISIBLE) {
        return;
      }
      
      const publishedCategory = row[colIndex('公開カテゴリ')];
      const category = publishedCategory || 'その他';
      categorySet.add(category);
    });
    
    const categories = Array.from(categorySet).sort();
    
    Logger.log('[getCategories] found ' + categories.length + ' categories: ' + categories.join(', '));
    
    return {
      categories: categories,
      updatedAt: new Date().toISOString()
    };
  } catch (error) {
    Logger.log('[getCategories] error: ' + error.message);
    Logger.log('[getCategories] stack: ' + error.stack);
    throw error;
  }
}

/**
 * 指定カテゴリのタグ一覧を取得
 * @param {string} category - カテゴリ名
 * @return {Object} { tags: string[], updatedAt: string }
 */
function getTagsForCategory(category) {
  try {
    Logger.log('[getTagsForCategory] start with category: ' + category);
    
    const cache = CacheService.getScriptCache();
    const cacheKey = 'tags_' + category;
    
    // キャッシュから取得を試みる
    const cached = cache.get(cacheKey);
    if (cached) {
      Logger.log('[getTagsForCategory] cache hit for key: ' + cacheKey);
      const data = JSON.parse(cached);
      Logger.log('[getTagsForCategory] returning ' + data.tags.length + ' tags from cache');
      return data;
    }
    
    // キャッシュがない場合はスプレッドシートから取得
    Logger.log('[getTagsForCategory] cache miss, fetching from sheet');
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('メニュー');
    if (!sheet) {
      Logger.log('[getTagsForCategory] sheet not found');
      return { tags: [], updatedAt: new Date().toISOString() };
    }
    
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const lastRow = sheet.getLastRow();
    
    if (lastRow < 2) {
      Logger.log('[getTagsForCategory] no data rows');
      return { tags: [], updatedAt: new Date().toISOString() };
    }
    
    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    const colIndex = (name) => headers.indexOf(name);
    
    const tagSet = new Set();
    
    data.forEach(row => {
      const publishStatus = row[colIndex('メニュー表示状態')];
      if (publishStatus !== PUBLISH_STATUS.VISIBLE) {
        return;
      }
      
      // カテゴリフィルタ
      const publishedCategory = row[colIndex('公開カテゴリ')];
      const rowCategory = publishedCategory || 'その他';
      if (rowCategory !== category) {
        return;
      }
      
      // 公開タグを取得
      const publishedTags = row[colIndex('公開タグ')];
      const tagsStr = publishedTags || '';
      
      if (tagsStr) {
        const tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean);
        tags.forEach(tag => tagSet.add(tag));
      }
    });
    
    const tags = Array.from(tagSet).sort();
    
    Logger.log('[getTagsForCategory] found ' + tags.length + ' tags: ' + tags.join(', '));
    
    const result = {
      tags: tags,
      updatedAt: new Date().toISOString()
    };
    
    // 10分間キャッシュ（600秒）
    try {
      cache.put(cacheKey, JSON.stringify(result), 600);
      Logger.log('[getTagsForCategory] cached for 600 seconds with key: ' + cacheKey);
    } catch (cacheError) {
      Logger.log('[getTagsForCategory] cache put failed: ' + cacheError.message);
      // キャッシュ失敗してもデータは返す
    }
    
    return result;
  } catch (error) {
    Logger.log('[getTagsForCategory] error: ' + error.message);
    Logger.log('[getTagsForCategory] stack: ' + error.stack);
    throw error;
  }
}

/**
 * シートからメニューデータを取得
 * @param {Sheet} sheet - メニューシート
 * @param {string} filterCategory - フィルタするカテゴリ（null の場合は全件）
 */
function getMenuData(sheet, filterCategory) {
  try {
    Logger.log('[getMenuData] start with filterCategory: ' + filterCategory);
    
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
  
  const items = [];
  
  data.forEach((row, index) => {
    const publishStatus = row[colIndex('メニュー表示状態')];
    const isVisible = publishStatus === PUBLISH_STATUS.VISIBLE;
    
    if (!isVisible) {
      return;
    }
    
    // カテゴリフィルタ
    if (filterCategory) {
      const publishedCategory = row[colIndex('公開カテゴリ')];
      const category = publishedCategory || 'その他';
      if (category !== filterCategory) {
        return;
      }
    }
    
    // 行番号をIDとして使用（データは2行目から始まるので index + 2）
    const rowNumber = index + 2;
    
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
    let alcoholVolume = abvStr ? parseFloat(abvStr) : undefined;
    
    // スプレッドシートのパーセント形式は小数で保存されているため、1未満の場合は100倍
    if (alcoholVolume !== undefined && alcoholVolume < 1) {
      alcoholVolume = alcoholVolume * 100;
    }
    
    // 浮動小数点の精度問題を回避するため、小数点以下1桁に丸める
    if (alcoholVolume !== undefined) {
      alcoholVolume = Math.round(alcoholVolume * 10) / 10;
    }
    
    const price30ml = parseFloat(String(row[colIndex('30ml')] || '').replace(/[^0-9.]/g, '')) || undefined;
    const price15ml = parseFloat(String(row[colIndex('15ml')] || '').replace(/[^0-9.]/g, '')) || undefined;
    const price10ml = parseFloat(String(row[colIndex('10ml')] || '').replace(/[^0-9.]/g, '')) || undefined;
    
    const publishedCountry = row[colIndex('公開国')];
    const sourceCountry = row[colIndex('国')];
    const country = publishedCountry || sourceCountry || '';
    
    const publishedDistillery = row[colIndex('公開蒸溜所')];
    const sourceDistillery = row[colIndex('蒸溜所')];
    const distillery = publishedDistillery || sourceDistillery || '';
    
    const publishedCaskType = row[colIndex('公開樽種')];
    const sourceCaskType = row[colIndex('樽種')];
    const caskType = publishedCaskType || sourceCaskType || '';
    
    const publishedMaturationPeriod = row[colIndex('公開熟成期間')];
    const sourceMaturationPeriod = row[colIndex('熟成期間')];
    const maturationPeriod = publishedMaturationPeriod || sourceMaturationPeriod || '';
    
    items.push({
      id: String(rowNumber),
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
      country,
      distillery,
      caskType,
      maturationPeriod
    });
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
    
    // 候補数の上限を緩和（銘柄名とIDのみなのでトークン消費は少ない）
    // 1000件でも約6,000トークン程度なので問題なし
    if (request.candidates.length > 1000) {
      return {
        error: true,
        message: '候補が多すぎます（最大1000件）',
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
    
    // レート制限・トークン制限エラーの特別処理
    if (error.message === 'RATE_LIMIT_EXCEEDED') {
      return {
        error: true,
        message: '現在、おすすめ機能は利用できません。API利用制限に達しています。しばらく時間をおいてから再度お試しください。',
        code: 'RATE_LIMIT'
      };
    }
    
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
      maxOutputTokens: 1200,  // 5件のおすすめに対応（各200トークン程度）
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
    
    // エラーレスポンスを解析
    try {
      const errorData = JSON.parse(responseText);
      
      // レート制限・トークン制限エラー
      if (statusCode === 429 || (errorData.error && errorData.error.code === 429)) {
        throw new Error('RATE_LIMIT_EXCEEDED');
      }
      
      // その他のエラー
      const errorMessage = errorData.error && errorData.error.message 
        ? errorData.error.message 
        : 'Gemini API error: ' + statusCode;
      throw new Error(errorMessage);
    } catch (parseError) {
      // JSON解析失敗時
      if (parseError.message === 'RATE_LIMIT_EXCEEDED') {
        throw parseError;
      }
      throw new Error('Gemini API error: ' + statusCode);
    }
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
  if (prefs.category) prefsText += `カテゴリ: ${prefs.category}\n`;
  if (prefs.selectedTags && prefs.selectedTags.length > 0) {
    prefsText += `希望する味わい・特徴: ${prefs.selectedTags.join('、')}\n`;
  }
  if (prefs.maxPrice) prefsText += `最大価格: ${prefs.maxPrice}円\n`;
  if (prefs.memo) prefsText += `その他の希望: ${prefs.memo}\n`;
  
  if (!prefsText) {
    prefsText = '特になし（幅広く提案してください）';
  }
  
  const candidatesText = candidates.map((c, i) => {
    return `${i + 1}. ${c.name} [ID: ${c.id}]`;
  }).join('\n');
  
  return `あなたはプロのバーテンダーです。お客様の好みに合わせて、以下の候補から最適な5つのお酒をおすすめしてください。

## お客様の好み
${prefsText}

## 候補リスト（${candidates.length}件の銘柄から選んでください）
${candidatesText}

## 重要な注意事項
- **"id"には必ず上記の候補リストに記載されている [ID: XX] の数字をそのまま使ってください**
- 例えば「17. 山崎10年 [ID: 128]」の場合、idは "128" です
- リスト番号（1, 2, 3...）ではなく、[ID: ] 内の数字を使ってください

## 指示
1. 上記の候補から、お客様の好みに最も合う5つを選んでください
2. 各おすすめについて、80〜120文字程度の理由を日本語で書いてください
3. おすすめ理由は、**その銘柄の実際の味わいや特徴を、バーテンダーとして自然な言葉で説明してください**
4. 「タグに〜と記載」のようなメタ情報への言及は避け、直接的な味わりの説明を心がけてください
5. お客様に語りかけるような、親しみやすく魅力的な説明を心がけてください
6. 必ず以下のJSON形式で返してください（他のテキストは含めないでください）

\`\`\`json
{
  "items": [
    {
      "id": "128",
      "reason": "おすすめ理由（80〜120文字、自然な語り口で）",
      "serve": "提供方法（オプション、例: ストレート、ロック等）"
    },
    {
      "id": "45",
      "reason": "おすすめ理由",
      "serve": "ロック"
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
    logSheet.appendRow(['タイムスタンプ', 'カテゴリ', '選択タグ', '最大価格', 'メモ', '候補数', 'おすすめ件数', 'レイテンシ(ms)', '応答']);
  }
  
  const timestamp = new Date().toISOString();
  const prefs = request.prefs || {};
  const category = prefs.category || '';
  const selectedTags = prefs.selectedTags && prefs.selectedTags.length > 0 ? prefs.selectedTags.join('、') : '';
  const maxPrice = prefs.maxPrice || '';
  const memo = prefs.memo || '';
  const candidatesCount = request.candidates ? request.candidates.length : 0;
  const itemsCount = response.items ? response.items.length : 0;
  const responseText = JSON.stringify(response);
  
  logSheet.appendRow([timestamp, category, selectedTags, maxPrice, memo, candidatesCount, itemsCount, latencyMs, responseText]);
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
    .addItem('AI補完を実行 (最大10件)', 'requestAiCompletion')
    .addSeparator()
    .addItem('メニューに表示', 'showInMenu')
    .addItem('メニューから非表示', 'hideFromMenu')
    .addSeparator()
    .addItem('キャッシュをクリア', 'clearMenuCache')
    .addSeparator()
    .addItem('データ確認（デバッグ）', 'debugMenuData')
    .addItem('Gemini API接続テスト', 'testGeminiAPI')
    .addItem('初期設定', 'setupMenuSheet')
    .addItem('設定を確認', 'checkSettings')
    .addToUi();
}

// ===== onEdit トリガー（優先公開列編集時に公開状態をクリア） =====
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
  
  // 優先公開列が編集されたら「メニュー表示状態」をクリア＋キャッシュクリア
  if (col >= colIdStart && col <= colIdEnd && colPublishStatus > 0) {
    sheet.getRange(row, colPublishStatus).setValue('');
    clearMenuCache();
  }
}

// ===== ボタン: AI補完を実行 =====
function requestAiCompletion() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const activeRange = sheet.getActiveRange();
  const firstRow = activeRange.getRow();
  const lastRow = activeRange.getLastRow();
  
  if (firstRow <= 1) {
    SpreadsheetApp.getUi().alert('エラー', 'データ行を選択してください', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
  // 選択行数を計算
  const selectedRowCount = lastRow - firstRow + 1;
  
  // 10件を超える場合はエラー
  if (selectedRowCount > 10) {
    SpreadsheetApp.getUi().alert(
      'エラー',
      '一度に処理できるのは最大10件までです。\n\n現在の選択: ' + selectedRowCount + '件\n\n10件以下に絞って再度お試しください。',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    return;
  }
  
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  
  // 確認ダイアログ
  let confirmMessage;
  if (selectedRowCount === 1) {
    const itemName = getItemName(sheet, firstRow, headers);
    confirmMessage = 'AI補完を実行します\n\n対象: ' + itemName + ' (' + firstRow + '行目)\n機能: 設定されていない値をAIで補完・修正します\n\n注意事項:\n• 即座にAI補完を実行し、結果を反映します\n• 処理には10〜30秒かかる場合があります\n• インターネット接続が必要です\n\n続行しますか？';
  } else {
    confirmMessage = 'AI補完を実行します（バッチ処理）\n\n対象: ' + selectedRowCount + '件\n範囲: ' + firstRow + '行目〜' + lastRow + '行目\n機能: 設定されていない値をAIで補完・修正します\n\n注意事項:\n• 即座にAI補完を実行し、結果を反映します\n• 処理には30〜60秒かかる場合があります\n• インターネット接続が必要です\n\n続行しますか？';
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
  
  // Gemini API Key取得
  const apiKey = PropertiesService.getScriptProperties().getProperty(PROP_GEMINI_API_KEY);
  if (!apiKey) {
    SpreadsheetApp.getUi().alert('エラー', 'GEMINI_API_KEYが設定されていません', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  
  // 全選択行のデータを収集
  const batchItems = [];
  for (let row = firstRow; row <= lastRow; row++) {
    const source = collectSourceData(sheet, row, headers);
    batchItems.push({
      row: row,
      data: source
    });
    
    // AI補完状態を「依頼済み」に
    sheet.getRange(row, colAiStatus).setValue(AI_STATUS.REQUESTED);
  }
  SpreadsheetApp.flush();
  
  try {
    // バッチでAI補完実行
    const batchResults = callGeminiForBatchCompletion_(apiKey, batchItems);
    
    // 各行に結果を反映
    let successCount = 0;
    let failCount = 0;
    
    batchResults.forEach((result, index) => {
      const row = batchItems[index].row;
      
      if (result.success && result.data) {
        // 公開列に反映
        updatePublishedColumns(sheet, row, headers, result.data);
        
        // AI補完状態を「成功」に
        sheet.getRange(row, colAiStatus).setValue(AI_STATUS.SUCCESS);
        successCount++;
      } else {
        // エラー時は「失敗」に設定
        sheet.getRange(row, colAiStatus).setValue(AI_STATUS.FAILED);
        failCount++;
      }
    });
    
    // キャッシュクリア（次回アクセス時に最新データを取得）
    clearMenuCache();
    
    // 結果表示
    let resultMessage = 'AI補完が完了しました。\n\n';
    resultMessage += '成功: ' + successCount + '件\n';
    if (failCount > 0) {
      resultMessage += '失敗: ' + failCount + '件\n';
    }
    resultMessage += '\n※ メニューに表示するには「メニューに表示」ボタンを押してください。';
    
    SpreadsheetApp.getUi().alert('AI補完完了', resultMessage, SpreadsheetApp.getUi().ButtonSet.OK);
    
  } catch (error) {
    // エラー時は全行を「失敗」に設定
    for (let row = firstRow; row <= lastRow; row++) {
      sheet.getRange(row, colAiStatus).setValue(AI_STATUS.FAILED);
    }
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
      ? 'メニューに表示しました\n\n対象: ' + itemNames[0] + '\n\nWebアプリで確認するには、ブラウザをリロード（F5）してください。'
      : 'メニューから非表示にしました\n\n対象: ' + itemNames[0] + '\n\nWebアプリで確認するには、ブラウザをリロード（F5）してください。';
  } else {
    const previewItems = itemNames.join('、');
    const moreText = processedCount > 3 ? '、他' + (processedCount - 3) + '件' : '';
    message = newPublishStatus === PUBLISH_STATUS.VISIBLE
      ? 'メニューに表示しました\n\n対象: ' + processedCount + '行\n（' + previewItems + moreText + '）\n\nWebアプリで確認するには、ブラウザをリロード（F5）してください。'
      : 'メニューから非表示にしました\n\n対象: ' + processedCount + '行\n（' + previewItems + moreText + '）\n\nWebアプリで確認するには、ブラウザをリロード（F5）してください。';
  }
  
  SpreadsheetApp.getUi().alert(message);
}

// ===== ボタン: 設定確認 =====
function checkSettings() {
  const props = PropertiesService.getScriptProperties();
  const geminiApiKey = props.getProperty(PROP_GEMINI_API_KEY);
  
  // キャッシュの状態確認
  const cache = CacheService.getScriptCache();
  const cached = cache.get('menuData');
  const cacheStatus = cached ? '有効（10分間）' : 'なし';
  
  // AI_Logsから今日の使用統計を取得
  const stats = getAiUsageStats();
  
  const message = '設定状況:\n\n' +
    '【API設定】\n' +
    '• GEMINI_API_KEY: ' + (geminiApiKey ? '設定済み' : '未設定') + '\n' +
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
    '現在の使用量は十分に余裕があります。\n\n' +
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
      results += '[成功] API接続: OK\n\n';
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
        results += '[警告] モデルリストが空です\n';
      }
    } else {
      results += '[エラー] API接続エラー: ' + listStatusCode + '\n';
      results += 'レスポンス: ' + listResponse.getContentText().substring(0, 200);
    }
  } catch (error) {
    results += '[エラー] 例外エラー: ' + error.message + '\n\n';
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
  
  const publishStatus = row[colIndex('メニュー表示状態')];
  const name = row[colIndex('公開商品名')] || row[colIndex('商品名')];
  
  const message = 'デバッグ情報:\n\n' +
    '行番号: ' + activeRow + '\n' +
    '商品名: ' + (name || '(未設定)') + '\n' +
    'メニュー表示状態: [' + (publishStatus || '(空)') + ']\n' +
    '期待値: [' + PUBLISH_STATUS.VISIBLE + ']\n' +
    '一致: ' + (publishStatus === PUBLISH_STATUS.VISIBLE ? 'はい' : 'いいえ') + '\n\n' +
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
      let numeric = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.]/g, ''));
      if (isNaN(numeric)) return '';
      // スプレッドシートのパーセント形式は小数で保存されているため、1未満の場合は100倍
      if (numeric < 1) {
        numeric = numeric * 100;
      }
      // 浮動小数点の精度問題を回避するため、小数点以下1桁に丸める
      numeric = Math.round(numeric * 10) / 10;
      return numeric;
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
 * Gemini APIでAI補完実行（バッチ処理）
 * @param {string} apiKey - Gemini API Key
 * @param {Array} batchItems - [{ row: number, data: object }]
 * @return {Array} [{ success: boolean, data?: object }]
 */
function callGeminiForBatchCompletion_(apiKey, batchItems) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=' + apiKey;
  
  // バッチプロンプト生成
  const prompt = buildBatchCompletionPrompt_(batchItems);
  
  const payload = {
    contents: [{
      parts: [{
        text: prompt
      }]
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192, // バッチ処理用に増量（10件で約6000トークン想定）
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
    Logger.log('[callGeminiForBatchCompletion] error: ' + statusCode + ' ' + responseText);
    
    // エラーレスポンスを解析
    try {
      const errorData = JSON.parse(responseText);
      
      // レート制限・トークン制限エラー
      if (statusCode === 429 || (errorData.error && errorData.error.code === 429)) {
        throw new Error('API利用制限に達しています。しばらく時間をおいてから再度お試しください。');
      }
      
      // その他のエラー
      const errorMessage = errorData.error && errorData.error.message 
        ? errorData.error.message 
        : 'Gemini API error: ' + statusCode;
      throw new Error(errorMessage);
    } catch (parseError) {
      // JSON解析失敗時
      if (parseError.message.indexOf('API利用制限') !== -1) {
        throw parseError;
      }
      throw new Error('Gemini API error: ' + statusCode);
    }
  }
  
  Logger.log('[callGeminiForBatchCompletion] response length: ' + responseText.length);
  
  const result = JSON.parse(responseText);
  
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
    Logger.log('[callGeminiForBatchCompletion] Full response: ' + responseText);
    throw new Error('テキストが見つかりません。finishReason: ' + (candidate.finishReason || 'unknown') + '. レスポンス全体はログを確認してください。');
  }
  
  if (!text || text.trim().length === 0) {
    throw new Error('空のテキストが返されました。finishReason: ' + (candidate.finishReason || 'unknown'));
  }
  
  // バッチレスポンスをパース
  const batchResponse = extractJSON_(text);
  
  // 各アイテムの結果を構築
  const results = [];
  
  if (Array.isArray(batchResponse.items)) {
    // items配列形式の場合
    batchResponse.items.forEach((item, index) => {
      results.push({
        success: true,
        data: item
      });
    });
  } else if (typeof batchResponse === 'object' && batchResponse.name) {
    // 単一オブジェクト形式の場合（1件のみの処理）
    results.push({
      success: true,
      data: batchResponse
    });
  }
  
  // 結果の件数が入力と一致しない場合、不足分を失敗として追加
  while (results.length < batchItems.length) {
    results.push({
      success: false
    });
  }
  
  return results;
}

/**
 * Gemini APIでAI補完実行（単一件・後方互換用）
 */
function callGeminiForCompletion_(apiKey, source) {
  // バッチ処理を使用
  const batchResult = callGeminiForBatchCompletion_(apiKey, [{ row: 0, data: source }]);
  
  if (batchResult.length > 0 && batchResult[0].success) {
    return batchResult[0].data;
  } else {
    throw new Error('AI補完に失敗しました');
  }
}

/**
 * AI補完プロンプト生成（バッチ処理用）
 */
function buildBatchCompletionPrompt_(batchItems) {
  let prompt = '以下の複数の「お酒（酒類）アイテム」の情報について、公式情報（メーカー公式サイト、正規輸入元、公式資料）を最優先に、欠損値または明らかに間違っている情報のみを補完・修正してください。\n\n';
  
  prompt += '補完対象:\n';
  prompt += '- 空欄・未入力のフィールド\n';
  prompt += '- 明らかに間違っている情報（例：存在しないメーカー名、不整合な度数、誤った国名など）\n';
  prompt += '- 整合性のない情報（例：商品名とメーカーが一致しない、不可能な熟成年数など）\n\n';
  
  prompt += '既存値が妥当で正確な場合は変更せず、欠損または誤りがあるフィールドのみを返してください。\n\n';
  
  prompt += 'JSONスキーマ（各アイテムについて補完が必要なフィールドのみ返す）:\n';
  prompt += '{\n';
  prompt += '  "name": "商品名",\n';
  prompt += '  "maker": "メーカー名（正規表記）",\n';
  prompt += '  "category": "カテゴリ（酒種。例：ウイスキー／ラム／ジン／ビール／ワイン 等）",\n';
  prompt += '  "type": "タイプ（酒種内の分類。例：ウイスキーならシングルモルト・ブレンデッド、ラムならダーク・ホワイト、ワインならフルボディ 等）",\n';
  prompt += '  "description": "50〜80文字程度の説明（宣伝文句ではなく中立・簡潔）",\n';
  prompt += '  "tags": ["3〜5個の味わい・特徴タグ（必ず日本語で。例：スモーキー、フルーティー、華やか、滑らか、ピーティー、バニラ、スパイシー）"],\n';
  prompt += '  "country": "生産国（必ず和名で統一。例：スコットランド、アイルランド、アメリカ、日本）",\n';
  prompt += '  "maturationPeriod": "熟成年数／期間（該当しない場合は空文字 \'\'）",\n';
  prompt += '  "caskType": "樽種／熟成容器（該当しない場合は空文字 \'\'）",\n';
  prompt += '  "alcoholVolume": "度数 (整数値、例: 43, 43.5)"\n';
  prompt += '}\n\n';
  
  prompt += '前提・ポリシー:\n';
  prompt += '- 公式情報を最優先。非公式情報しか見つからない場合は一般に妥当な定説を用いる。\n';
  prompt += '- 不明な項目は空文字（\'\'）とし、N/Aや未定義などの文字列は使わない。\n';
  prompt += '- 事実と推定が混同しないよう、description は断定的表現を避け簡潔に。\n';
  prompt += '- 既存値が正確な場合は変更しない。\n';
  prompt += '- **tagsは必ず日本語で記述してください。カタカナ語も含めて、すべて日本語で統一してください。**\n';
  prompt += '- 必ず有効なJSONのみを返してください。説明文やコメントは一切含めないでください。\n\n';
  
  prompt += '重要: レスポンスは必ず以下の形式のJSON配列で返してください:\n';
  prompt += '```json\n';
  prompt += '{\n';
  prompt += '  "items": [\n';
  prompt += '    {\n';
  prompt += '      "name": "商品名1",\n';
  prompt += '      "maker": "メーカー名1",\n';
  prompt += '      "category": "カテゴリ1",\n';
  prompt += '      ...\n';
  prompt += '    },\n';
  prompt += '    {\n';
  prompt += '      "name": "商品名2",\n';
  prompt += '      "maker": "メーカー名2",\n';
  prompt += '      "category": "カテゴリ2",\n';
  prompt += '      ...\n';
  prompt += '    }\n';
  prompt += '  ]\n';
  prompt += '}\n';
  prompt += '```\n\n';
  
  prompt += '処理対象アイテム（' + batchItems.length + '件）:\n\n';
  
  batchItems.forEach((item, index) => {
    prompt += '--- アイテム ' + (index + 1) + ' ---\n';
    prompt += JSON.stringify(item.data, null, 2) + '\n\n';
  });
  
  return prompt;
}

/**
 * AI補完プロンプト生成（単一件・後方互換用）
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
    '  "type": "タイプ（酒種内の分類。例：ウイスキーならシングルモルト・ブレンデッド、ラムならダーク・ホワイト、ワインならフルボディ 等）",\n' +
    '  "description": "50〜80文字程度の説明（宣伝文句ではなく中立・簡潔）",\n' +
    '  "tags": ["3〜5個の味わい・特徴タグ（必ず日本語で。例：スモーキー、フルーティー、華やか、滑らか、ピーティー、バニラ、スパイシー）"],\n' +
    '  "country": "生産国（必ず和名で統一。例：スコットランド、アイルランド、アメリカ、日本）",\n' +
    '  "maturationPeriod": "熟成年数／期間（該当しない場合は空文字 \'\'）",\n' +
    '  "caskType": "樽種／熟成容器（該当しない場合は空文字 \'\'）",\n' +
    '  "alcoholVolume": "度数 (整数値、例: 43, 43.5)"\n' +
    '}\n\n' +
    '前提・ポリシー:\n' +
    '- 公式情報を最優先。非公式情報しか見つからない場合は一般に妥当な定説を用いる。\n' +
    '- 不明な項目は空文字（\'\'）とし、N/Aや未定義などの文字列は使わない。\n' +
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
  if (aiResult.country) {
    const countryValue = String(aiResult.country).trim();
    // N/Aや類似の文字列は空欄にする
    if (countryValue && countryValue !== 'N/A' && countryValue !== 'n/a' && countryValue !== '-') {
      sheet.getRange(row, colIndex('公開国')).setValue(countryValue);
    }
  }
  if (aiResult.distillery) {
    const distilleryValue = String(aiResult.distillery).trim();
    if (distilleryValue && distilleryValue !== 'N/A' && distilleryValue !== 'n/a' && distilleryValue !== '-') {
      sheet.getRange(row, colIndex('公開蒸溜所')).setValue(distilleryValue);
    }
  }
  if (aiResult.caskType) {
    const caskTypeValue = String(aiResult.caskType).trim();
    if (caskTypeValue && caskTypeValue !== 'N/A' && caskTypeValue !== 'n/a' && caskTypeValue !== '-') {
      sheet.getRange(row, colIndex('公開樽種')).setValue(caskTypeValue);
    }
  }
  if (aiResult.maturationPeriod) {
    const maturationValue = String(aiResult.maturationPeriod).trim();
    if (maturationValue && maturationValue !== 'N/A' && maturationValue !== 'n/a' && maturationValue !== '-') {
      sheet.getRange(row, colIndex('公開熟成期間')).setValue(maturationValue);
    }
  }
}

// ===== ユーティリティ関数 =====
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
