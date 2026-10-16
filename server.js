// ════════════════════════════════════════════════════════════════════
//  imdb-live-proxy — وسيط حيّ لبيانات IMDb من مضيف غير محجوب (Render)
//
//  لماذا؟ Cloudflare محجوب من IMDb (429 لـGraphQL و403 للصفحات)، فيتعذّر
//  على قاعدة shownow.pages.dev قراءة IMDb اللحظية. هذا الوسيط الرقيق
//  (بلا أي اعتماديات) يعمل من IP آمن ويعيد القيمة الدقيقة للتقييم.
//
//    GET /health                     → { ok, uptime }
//    GET /verify/<tt...>             → فحص وصول IMDb من هذا المضيف
//    GET /rating/<tt...>             → { id, rating, votes, source, ms }
//    GET /episode/<tt>/<s>/<e>       → { id, resolvedId, rating, votes, source }
//
//  الحماية: ترويسة `x-proxy-key` تُقارن بـ PROXY_KEY (تُفرض إن كان المتغيّر مضبوطاً).
// ════════════════════════════════════════════════════════════════════
import http from 'node:http';

const PORT = process.env.PORT || 3000;
const KEY = process.env.PROXY_KEY || '';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0';
const GQL = 'https://graphql.imdb.com/';
const GQL_HEADERS = {
  'content-type': 'application/json',
  'x-imdb-client-name': 'imdb-web-next-local',
  'x-imdb-user-country': 'US',
  'user-agent': UA,
};
const ID_RE = /^tt\d{5,}$/;
const EPISODE_PAGE = 250;
const EPISODE_MAX_PAGES = 3;

const startedAt = Date.now();

async function gql(query, variables, timeoutMs = 9000) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: GQL_HEADERS,
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* ردّ غير JSON */
  }
  return { status: res.status, data, snippet: text.slice(0, 200) };
}

const normVotes = (v) => {
  const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

/** تقييم عنوان بعينه (فيلم/مسلسل/حلقة) بمعرّفه. */
async function ratingOf(id) {
  const { status, data, snippet } = await gql(
    'query($id: ID!) { title(id: $id) { ratingsSummary { aggregateRating voteCount } } }',
    { id },
  );
  const summary = data?.data?.title?.ratingsSummary;
  const rating = typeof summary?.aggregateRating === 'number' ? summary.aggregateRating : null;
  if (rating == null) return { ok: false, status, id, snippet };
  return { ok: true, id, rating, votes: normVotes(summary.voteCount), source: 'imdb-graphql' };
}

/** حلّ حلقة بصيغة (مسلسل/موسم/حلقة) → معرّف IMDb + تقييمه. */
async function episodeOf(seriesId, season, episode) {
  let after = null;
  for (let page = 0; page < EPISODE_MAX_PAGES; page++) {
    const args = `first: ${EPISODE_PAGE}${after ? ', after: $after' : ''}`;
    const vars = after ? '$id: ID!, $after: ID!' : '$id: ID!';
    const { status, data } = await gql(
      `query(${vars}) { title(id: $id) { episodes { episodes(${args}) { pageInfo { hasNextPage endCursor } edges { node { id series { episodeNumber { seasonNumber episodeNumber } } ratingsSummary { aggregateRating voteCount } } } } } } }`,
      after ? { id: seriesId, after } : { id: seriesId },
      12000,
    );
    const conn = data?.data?.title?.episodes?.episodes;
    if (!conn) return { ok: false, status, seriesId, season, episode };
    for (const edge of conn.edges || []) {
      const num = edge?.node?.series?.episodeNumber;
      if (num?.seasonNumber === season && num?.episodeNumber === episode) {
        const summary = edge.node.ratingsSummary;
        const rating = typeof summary?.aggregateRating === 'number' ? summary.aggregateRating : null;
        return {
          ok: rating != null,
          id: `${seriesId}:${season}:${episode}`,
          resolvedId: edge.node.id,
          rating,
          votes: normVotes(summary?.voteCount),
          source: 'imdb-graphql',
        };
      }
    }
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return { ok: false, reason: 'episode_not_found', seriesId, season, episode };
}

/** تعداد كل حلقات موسم واحد بنداء واحد (أذكى من حلقة بحلقة). */
async function seasonOf(seriesId, season) {
  const episodes = [];
  let after = null;
  for (let page = 0; page < EPISODE_MAX_PAGES; page++) {
    const args = `first: ${EPISODE_PAGE}${after ? ', after: $after' : ''}`;
    const vars = after ? '$id: ID!, $after: ID!' : '$id: ID!';
    const { status, data } = await gql(
      `query(${vars}) { title(id: $id) { episodes { episodes(${args}) { pageInfo { hasNextPage endCursor } edges { node { id series { episodeNumber { seasonNumber episodeNumber } } ratingsSummary { aggregateRating voteCount } } } } } } }`,
      after ? { id: seriesId, after } : { id: seriesId },
      12000,
    );
    const conn = data?.data?.title?.episodes?.episodes;
    if (!conn) return { ok: false, status, seriesId, season, episodes };
    for (const edge of conn.edges || []) {
      const num = edge?.node?.series?.episodeNumber;
      if (num?.seasonNumber !== season) continue;
      const summary = edge.node.ratingsSummary;
      episodes.push({
        episode: num.episodeNumber,
        resolvedId: edge.node.id,
        rating: typeof summary?.aggregateRating === 'number' ? summary.aggregateRating : null,
        votes: normVotes(summary?.voteCount),
      });
    }
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  episodes.sort((a, b) => a.episode - b.episode);
  return { ok: episodes.length > 0, seriesId, season, episodes };
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const began = Date.now();
  const url = new URL(req.url || '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  if (KEY && req.headers['x-proxy-key'] !== KEY && parts[0] !== 'health') {
    return send(res, 401, { error: 'unauthorized' });
  }

  try {
    if (parts[0] === 'health' || parts.length === 0) {
      return send(res, 200, { ok: true, service: 'imdb-live-proxy', uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
    }

    if (parts[0] === 'verify' && parts[1]) {
      const result = await ratingOf(parts[1]);
      return send(res, result.ok ? 200 : 502, { reachable: result.ok, host: 'render', ...result, ms: Date.now() - began });
    }

    if (parts[0] === 'rating' && parts[1]) {
      if (!ID_RE.test(parts[1])) return send(res, 400, { error: 'invalid_id' });
      const result = await ratingOf(parts[1]);
      return send(res, result.ok ? 200 : 502, { ...result, ms: Date.now() - began });
    }

    if (parts[0] === 'episode' && parts[1] && parts[2] && parts[3]) {
      if (!ID_RE.test(parts[1])) return send(res, 400, { error: 'invalid_series_id' });
      const season = parseInt(parts[2], 10);
      const episode = parseInt(parts[3], 10);
      const result = await episodeOf(parts[1], season, episode);
      return send(res, result.ok ? 200 : 404, { ...result, ms: Date.now() - began });
    }

    if (parts[0] === 'season' && parts[1] && parts[2]) {
      if (!ID_RE.test(parts[1])) return send(res, 400, { error: 'invalid_series_id' });
      const season = parseInt(parts[2], 10);
      if (!Number.isFinite(season)) return send(res, 400, { error: 'invalid_season' });
      const result = await seasonOf(parts[1], season);
      return send(res, result.ok ? 200 : 404, { ...result, ms: Date.now() - began });
    }

    return send(res, 404, { error: 'not_found', path: url.pathname });
  } catch (err) {
    return send(res, 500, { error: 'proxy_error', message: err?.message ?? String(err), ms: Date.now() - began });
  } finally {
    console.log(`${req.method} ${url.pathname} → ${res.statusCode} (${Date.now() - began}ms)`);
  }
});

server.listen(PORT, () => console.log(`imdb-live-proxy listening on :${PORT}`));
