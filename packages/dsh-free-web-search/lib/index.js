// free-web-search — DSH ctx.web 搜索提供方：DuckDuckGo（免费、无 key）。
// 注册 id 为 `duckduckgo`；bundle patch 把 web 行的 `searchProvider`
// 固定为 `duckduckgo`，替代默认的 deepseek-official。
//
// 实现：POST https://html.duckduckgo.com/html/ 解析 HTML 结果，零依赖。
// 提供方接口见 @deepseek-ai/dsh-web 的 WebSearchProvider：
//   { id, available(): boolean, search({query, maxResults}, signal) }

const PROVIDER_ID = 'duckduckgo';
const ENDPOINT = 'https://html.duckduckgo.com/html/';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function webError(message, code, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

// //duckduckgo.com/l/?uddg=<encoded>&rut=... → 真实 URL
function decodeDdgHref(href) {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : url.href;
  } catch {
    return href;
  }
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** 按文档顺序收集含指定 class 的 <a>，返回 { href, text }。 */
function extractAnchors(html, className) {
  const anchors = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const attrs = match[1];
    const classMatch = /class="([^"]*)"/.exec(attrs);
    if (!classMatch || !classMatch[1].split(/\s+/).includes(className)) continue;
    const hrefMatch = /href="([^"]*)"/.exec(attrs);
    anchors.push({ href: hrefMatch ? hrefMatch[1] : '', text: match[2] });
  }
  return anchors;
}

async function search(request, signal) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
        accept: 'text/html',
      },
      body: new URLSearchParams({ q: request.query }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw webError('duckduckgo: search aborted', 'WEB_ABORTED', error);
    }
    throw webError(`duckduckgo: request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', error);
  }

  if (!response.ok) {
    throw webError(`duckduckgo: HTTP ${response.status}`, 'WEB_PROVIDER_ERROR');
  }

  const html = await response.text();
  const titles = extractAnchors(html, 'result__a');
  const snippets = extractAnchors(html, 'result__snippet');

  const sources = [];
  for (let i = 0; i < titles.length; i++) {
    const url = decodeDdgHref(titles[i].href);
    if (!/^https?:\/\//.test(url)) continue; // 跳过广告/内链
    const snippet = snippets[i] ? stripTags(snippets[i].text) : undefined;
    sources.push({
      url,
      title: stripTags(titles[i].text) || undefined,
      snippet: snippet || undefined,
    });
  }
  return { sources, truncated: false };
}

const plugin = {
  name: 'free-web-search',
  inject: ['web'],

  apply(ctx, config) {
    ctx.web.registerSearchProvider({
      id: config?.id ?? PROVIDER_ID,
      available: () => true,
      search,
    });
    ctx.logger.info(`free-web-search: registered search provider "${PROVIDER_ID}" → ${ENDPOINT}`);
  },
};

export default plugin;
