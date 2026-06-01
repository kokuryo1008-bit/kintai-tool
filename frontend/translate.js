/* 自動翻訳ユーティリティ — MyMemory 無料API使用 */

/* 日本語テキストかどうか判定（ひらがな・カタカナ・漢字を含む場合はスキップ） */
function _isJapanese(text) {
  return /[぀-ヿ一-鿿]/.test(text);
}

/* MyMemory API で日本語に翻訳 */
async function translateToJP(text) {
  if (!text || !text.trim()) return null;
  if (_isJapanese(text)) return null; // すでに日本語→スキップ

  const url = 'https://api.mymemory.translated.net/get?q='
    + encodeURIComponent(text.trim())
    + '&langpair=auto|ja';

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Network error');
  const data = await res.json();
  if (data.responseStatus !== 200) throw new Error(data.responseDetails || 'API error');
  const translated = data.responseData?.translatedText || '';
  if (!translated || translated === text.trim()) return null; // 翻訳結果が同じならスキップ
  return translated;
}

/* 翻訳ボタン付きHTMLを生成するヘルパー
 * text: 表示テキスト（空の場合は null を渡す）
 * fallback: テキストが空のときの表示（省略時 '--'）
 */
function tlSpan(text, fallback = '--') {
  if (!text || !text.trim()) return `<span style="color:var(--text-muted)">${fallback}</span>`;
  return `<span class="tl-wrap" style="display:inline-flex;align-items:baseline;gap:4px;flex-wrap:wrap">
    <span class="tl-orig">${escHtml(text)}</span>
    <button class="tl-btn" title="日本語に翻訳" onclick="onTlClick(this)"
      style="flex-shrink:0;background:none;border:1px solid #CBD5E1;border-radius:8px;cursor:pointer;font-size:0.72rem;padding:1px 5px;color:#64748B;line-height:1.4">🌐</button>
    <span class="tl-result" style="display:none;font-size:0.82rem;color:#1E40AF;background:#EFF6FF;border-radius:4px;padding:1px 6px"></span>
  </span>`;
}

/* 翻訳ボタンクリックハンドラ */
async function onTlClick(btn) {
  const wrap   = btn.closest('.tl-wrap');
  const orig   = wrap.querySelector('.tl-orig');
  const result = wrap.querySelector('.tl-result');

  // 既訳なら表示/非表示トグル
  if (result.dataset.translated) {
    result.style.display = result.style.display === 'none' ? '' : 'none';
    return;
  }

  btn.textContent = '⏳';
  btn.disabled = true;
  try {
    const translated = await translateToJP(orig.textContent);
    if (translated) {
      result.textContent = '→ ' + translated;
      result.dataset.translated = '1';
      result.style.display = '';
    } else {
      result.textContent = '（日本語）';
      result.dataset.translated = '1';
      result.style.display = '';
    }
  } catch(e) {
    result.textContent = '翻訳失敗';
    result.style.display = '';
    result.style.color = '#EF4444';
  } finally {
    btn.textContent = '🌐';
    btn.disabled = false;
  }
}

/* セクション内の全 .tl-btn を一括翻訳
 * containerEl: 対象のDOM要素
 */
async function translateAll(containerEl) {
  const btns = [...containerEl.querySelectorAll('.tl-btn:not([data-done])')];
  for (const btn of btns) {
    if (!btn.dataset.done) {
      btn.dataset.done = '1';
      await onTlClick(btn);
      await new Promise(r => setTimeout(r, 300)); // APIへの連続リクエストを緩やかに
    }
  }
}

/* HTML エスケープ */
function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
