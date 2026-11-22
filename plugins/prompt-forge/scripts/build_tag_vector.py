#!/usr/bin/env python
"""build_tag_vector.py — 建 tag-vector.sqlite（spec §4）。

用法: .\\.venv\\Scripts\\python.exe plugins/prompt-master/scripts/build_tag_vector.py [--limit N] [--skip-wiki]
断点续跑: wiki 缓存 JSONL 逐条落盘，重跑只补缺。

产物:
  assets/knowledge/anima-prompt-v1/tag-vector.sqlite
    - vec0 虚拟表 vec_items: int8[PM_EMBED_DIM] distance_metric=cosine（与 Node 侧 Task 3 fixture 同 schema）
    - payload 表: rowid INTEGER PRIMARY KEY, record_id TEXT UNIQUE, text_source TEXT NOT NULL
    - meta 表: key/value provenance（model/provider/dim/count/quant/distance/built_at/text_sources）
      —— Node 查询侧（anima-vector.ts readMeta）打开时对账，维度错配 fail-fast（2026-09-15 定案）
  temp/anima-prompt-v1/wiki-cache/wiki-pages.jsonl（wiki 释义缓存，断点续跑）

对计划的两处布局修正（不改意图）:
  1. PRESET 取 parents[3]（scripts/ 在 plugins/prompt-master/ 下，parents[2] 是 plugins/ 而非 preset 根）。
  2. 知识资产实际落 <preset>/assets/knowledge/anima-prompt-v1/（与 resolveKnowledgePath 新布局一致）。

量化口径（与 Node 侧 quantizeInt8 完全一致）: per-vector max-abs 缩放，127 满幅，有符号 int8 两补码落盘
（实测见 probe 结论：sqlite-vec int8 列按有符号解释，+128 偏移会破坏 cosine 几何，不可用）。
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

PRESET = Path(__file__).resolve().parents[3]  # comfyui-chenxin preset root
CATALOG = PRESET / "assets" / "knowledge" / "anima-prompt-v1" / "tag-catalog.sqlite"
OUT = PRESET / "assets" / "knowledge" / "anima-prompt-v1" / "tag-vector.sqlite"
CACHE = PRESET / "temp" / "anima-prompt-v1" / "wiki-cache" / "wiki-pages.jsonl"
DIM = int(os.environ.get("PM_EMBED_DIM", "1024"))
MODEL = os.environ.get("PM_EMBED_MODEL", "BAAI/bge-m3")
USE_API = os.environ.get("PM_EMBED_PROVIDER", "").lower() == "api"
API_BASE = os.environ.get("PM_EMBED_API_BASE", "").rstrip("/")
API_KEY = os.environ.get("PM_EMBED_API_KEY", "")
API_MODEL = os.environ.get("PM_EMBED_API_MODEL", "")
API_BATCH = int(os.environ.get("PM_EMBED_API_BATCH", "64"))
CKPT = PRESET / "temp" / "anima-prompt-v1" / "api-embed-checkpoint.json"
WIKI_URL = "https://danbooru.donmai.us/wiki_pages.json"
TOKEN_RE = re.compile(r"[\r\n]+|\{\{[^}]*\}\}|\[[^\]]*\]|<[^>]*>")  # dokuwiki 标记粗剥


def load_catalog_tags():
    """读 records 全量（usage_count 降序）+ aliases 单遍聚合。

    对计划的一处数据修正：本 catalog 全部 1,374,902 条 record_id 都是**数字 id**
    （gelbooru tag id），tag 名在 canonical_name / prompt_form 里——计划原稿按
    record_id 组 passage 文本会把无意义数字编码进向量空间。改为编码 prompt_form
    （用户可见的空格形式），wiki 标题按 canonical_name（下划线形式）匹配。

    aliases 不用相关子查询（1.37M records × 无 record_id 索引的 names 表过慢），
    单遍读 name_type='alias'（约 1.3 万行）在 Python 侧聚合，语义等价。
    """
    if not CATALOG.exists():
        sys.exit(f"catalog not found: {CATALOG}")
    db = sqlite3.connect(f"file:{CATALOG}?mode=ro", uri=True)
    rows = db.execute(
        "SELECT record_id, canonical_name, prompt_form, category, usage_count "
        "FROM records ORDER BY usage_count DESC"
    ).fetchall()
    aliases = {}
    for rid, value in db.execute("SELECT record_id, value FROM names WHERE name_type='alias'"):
        aliases.setdefault(rid, []).append(value)
    db.close()
    return [(rid, cname, pform, cat, usage,
             ", ".join(aliases[rid]) if rid in aliases else None)
            for rid, cname, pform, cat, usage in rows]


def load_wiki_cache():
    """读 wiki JSONL 缓存为 {title: {title, body}}（fetch 续跑与纯缓存构建共用）。"""
    have = {}
    if CACHE.exists():
        for line in CACHE.read_text(encoding="utf-8").splitlines():
            if line.strip():
                p = json.loads(line)
                have[p["title"]] = p
    return have


def fetch_all_wiki_pages():
    """分页全量拉 wiki 页清单（对 spec §4 的细化：不逐 tag 查询）。限速 2 req/s + 退避。

    修正计划脚本的一处 bug：新拉到的页必须同步进 have 并返回，
    否则首跑建库时全部 fallback（缓存只供续跑补缺）。

    网络通道定案（t5 fix round 2）：CF 的 TLS 指纹识别拦 python-requests（换 UA 无效），
    实际拉取由 captain 的 curl 管线完成并落盘同一格式缓存；构建侧设
    WIKI_CACHE_READY=1 即短路 fetch、原样消费已完成的缓存（见 main）。
    """
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    have = load_wiki_cache()
    import requests
    s = requests.Session()
    # CF 反爬实测定案（t5 fix round 1）：requests 默认 UA（python-requests/2.x）是 Cloudflare
    # challenge 的首要打击目标 → 403 "Just a moment"；browser-like UA 可过。
    # 代理与凭据由调用方 env 注入（DANBOORU_LOGIN / DANBOORU_API_KEY / HTTPS_PROXY），
    # 本脚本不硬编码。
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "application/json",
    })
    if os.environ.get("DANBOORU_LOGIN"):
        s.auth = (os.environ["DANBOORU_LOGIN"], os.environ.get("DANBOORU_API_KEY", ""))
    retryable = {429, 403, 500, 502, 503}  # CF challenge 是瞬态：403 必须与 429 同列可重试
    page, done = 1, False
    new_count = 0
    with CACHE.open("a", encoding="utf-8") as f:
        while not done:
            r = None
            last_status = None
            for attempt in range(5):
                try:
                    r = s.get(WIKI_URL, params={"limit": 1000, "page": page}, timeout=30)
                    last_status = r.status_code
                    if r.status_code in retryable:
                        time.sleep(2 ** attempt)
                        continue
                    r.raise_for_status()
                    break
                except requests.RequestException as e:
                    last_status = getattr(getattr(e, "response", None), "status_code", None) or last_status
                    if attempt == 4:
                        sys.exit(f"wiki fetch failed at page {page} (last status {last_status}): {e}")
                    time.sleep(2 ** attempt)
            if r is None or (r.status_code in retryable):
                sys.exit(f"wiki fetch failed at page {page} (last status {last_status})")
            items = r.json()
            if not items:
                done = True
                break
            for it in items:
                if it["title"] not in have:
                    body = TOKEN_RE.sub(" ", it.get("body") or "")
                    p = {"title": it["title"], "body": body[:512]}
                    have[p["title"]] = p
                    f.write(json.dumps(p, ensure_ascii=False) + "\n")
                    new_count += 1
            f.flush()
            if page % 20 == 0:
                print(f"wiki pages fetched: page={page} cached={len(have)} (+{new_count})", flush=True)
            page += 1
            time.sleep(0.5)  # ~2 req/s
    print(f"wiki cache complete: {len(have)} pages (+{new_count} new)", flush=True)
    return have


CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")


def first_sentence(body: str) -> str:
    return body.strip()[:400]


def build_text(canonical_name, prompt_form, category, aliases, wiki_by_title_lower):
    name = CTRL_RE.sub(" ", (prompt_form or canonical_name or "").strip())
    parts = [name] if name else []
    if aliases:
        parts.append(CTRL_RE.sub(" ", aliases))
    parts.append(f"category:{category}")
    # danbooru wiki 标题是下划线+首字母大写形式（Serafuku），canonical_name 是小写/混合下划线形式
    # —— 大小写不敏感匹配
    w = wiki_by_title_lower.get((canonical_name or "").lower())
    src = "fallback"
    if w and w.get("body"):
        parts.append(first_sentence(w["body"]))
        src = "wiki"
    return " — ".join(parts), src


def quantize_int8(v):
    """per-vector max-abs 缩放 int8，127 满幅 —— 与 Node 侧 quantizeInt8 同口径。

    实测定案（temp/sdd-t7/probe_quant5.py）：sqlite-vec 的 int8 列按**有符号 int8**解释，
    存两补码（[-127,127] 直接 & 0xFF）时 cosine 距离与真实值误差 ≤0.005；
    计划原稿的 +128 偏移约定（字节域 1..255）会把几何彻底打碎（误差最高 1.6），已废弃。
    """
    m = max(abs(float(x)) for x in v) or 1.0
    return bytes((max(-127, min(127, int(round(float(x) / m * 127))))) & 0xFF for x in v)


def embed_api_batch(texts):
    """OpenAI 兼容 /embeddings 编码：内部按 API_BATCH 分片（Ark doubao-embedding-vision 实测
    单请求 input 上限 = 10），线程池并发（PM_EMBED_CONCURRENCY，默认 8）ex.map 保序提交，
    429/403/5xx 指数退避重试（stderr 留痕），4xx 参数错误打印响应体直接上抛。
    维度由 API 模型决定，须与 PM_EMBED_DIM 一致（vec0 表建表时校验）。
    """
    import requests
    from concurrent.futures import ThreadPoolExecutor
    conc = int(os.environ.get("PM_EMBED_CONCURRENCY", "8"))

    def one(chunk):
        last = None
        for attempt in range(6):
            try:
                r = requests.post(
                    f"{API_BASE}/embeddings",
                    headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
                    json={"model": API_MODEL, "input": chunk},
                    timeout=120,
                )
                if r.status_code in (429, 403, 500, 502, 503):
                    last = f"HTTP {r.status_code}"
                    print(f"[api] HTTP {r.status_code}, backoff {min(60, 2 ** attempt * 2)}s", flush=True)
                    time.sleep(min(60, 2 ** attempt * 2))
                    continue
                if r.status_code >= 400:
                    body = (r.text or "")[:500]
                    print(f"[api] HTTP {r.status_code}: {body}", flush=True)
                    raise RuntimeError(f"HTTP {r.status_code}: {body}")
                data = r.json()["data"]
                data.sort(key=lambda d: d["index"])
                return [d["embedding"] for d in data]
            except requests.RequestException as e:
                last = str(e)
                print(f"[api] {e}, backoff {min(60, 2 ** attempt * 2)}s", flush=True)
                time.sleep(min(60, 2 ** attempt * 2))
        raise RuntimeError(f"embeddings API failed after retries: {last}")

    chunks = [texts[s:s + API_BATCH] for s in range(0, len(texts), API_BATCH)]
    with ThreadPoolExecutor(max_workers=conc) as ex:
        results = list(ex.map(one, chunks))
    out = []
    for r in results:
        out.extend(r)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="只编码前 N 个 tag（调试用）")
    ap.add_argument("--skip-wiki", action="store_true", help="跳过 wiki 拉取（用缓存/纯 fallback）")
    args = ap.parse_args()

    tags = load_catalog_tags()
    if args.limit:
        tags = tags[: args.limit]
    print(f"tags to encode: {len(tags)}", flush=True)

    if args.skip_wiki:
        wiki_by_title_lower = {}
    elif os.environ.get("WIKI_CACHE_READY") == "1":
        # captain 的 curl 管线拥有网络拉取（CF TLS 指纹拦 python-requests，UA 无关）；
        # 缓存已完整落盘时短路 fetch，原样消费缓存（294,298 页，page 296 空自然耗尽）。
        wiki_cache = load_wiki_cache()
        print(f"wiki cache ready-skip: loaded {len(wiki_cache)} pages from {CACHE}", flush=True)
        wiki_by_title_lower = {t.lower(): p for t, p in wiki_cache.items()}
    else:
        wiki_by_title_lower = {t.lower(): p for t, p in fetch_all_wiki_pages().items()}

    import sqlite_vec

    model = None
    if not USE_API:
        from sentence_transformers import SentenceTransformer
        print(f"loading model {MODEL} ...", flush=True)
        model = SentenceTransformer(MODEL, device="cuda" if os.environ.get("FORCE_CUDA") else "cpu")
    else:
        if not (API_BASE and API_KEY and API_MODEL):
            sys.exit("api provider requires PM_EMBED_API_BASE / PM_EMBED_API_KEY / PM_EMBED_API_MODEL")
        print(f"api embedder: {API_MODEL} @ {API_BASE} (dim {DIM}, batch {API_BATCH})", flush=True)

    texts, meta = [], []
    for record_id, canonical_name, prompt_form, category, _usage, aliases in tags:
        t, src = build_text(canonical_name, prompt_form, category, aliases, wiki_by_title_lower)
        texts.append(t)
        meta.append((record_id, src))

    # API 编码断点：批次结束位置由 rowid 决定（rowid = i+j+1 确定性），同 model/dim/count 才可续跑
    start_row = 0
    if USE_API and CKPT.exists():
        try:
            ck = json.loads(CKPT.read_text(encoding="utf-8"))
            if ck.get("model") == API_MODEL and ck.get("dim") == DIM and ck.get("count") == len(texts):
                start_row = int(ck.get("last_row", 0))
                print(f"api checkpoint resume: skipping first {start_row} rows", flush=True)
        except Exception:
            pass

    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".sqlite.tmp")
    if tmp.exists():
        tmp.unlink()
    db = sqlite3.connect(tmp)
    db.enable_load_extension(True)
    sqlite_vec.load(db)
    db.enable_load_extension(False)
    db.execute(f"CREATE VIRTUAL TABLE vec_items USING vec0(embedding int8[{DIM}] distance_metric=cosine)")
    db.execute("CREATE TABLE payload(rowid INTEGER PRIMARY KEY, record_id TEXT UNIQUE, text_source TEXT NOT NULL)")
    db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    B = int(os.environ.get("PM_BUILD_BATCH", "512"))
    t0 = time.time()
    done = 0
    actual_dim = None  # 首批实测维度（防 env DIM 与模型输出漂移——768/1024 双默认事故的建库侧守卫）
    for i in range(0, len(texts), B):
        if USE_API:
            if i + B <= start_row:
                done += B
                continue
            emb = embed_api_batch(texts[i:i + B])
            CKPT.write_text(json.dumps({"model": API_MODEL, "dim": DIM, "count": len(texts), "last_row": i + B}), encoding="utf-8")
        else:
            # e5 系列需要 query/passage 前缀；bge-m3 官方用法不加前缀（池化为模型自带 CLS 配置）
            inputs = texts[i:i + B]
            if "e5" in MODEL.lower():
                inputs = ["passage: " + t for t in inputs]
            emb = model.encode(
                inputs,
                batch_size=B,
                normalize_embeddings=True,
            )
        for j, v in enumerate(emb):
            if actual_dim is None:
                actual_dim = len(v)
                if actual_dim != DIM:
                    sys.exit(
                        f"embedder output dim {actual_dim} != DIM {DIM} (PM_EMBED_DIM) — "
                        f"vec table was created int8[{DIM}]; set PM_EMBED_DIM to the model's true dim and rebuild"
                    )
            rowid = i + j + 1
            db.execute(
                "INSERT INTO vec_items(rowid, embedding) VALUES (?, vec_int8(?))",
                (rowid, quantize_int8(v)),
            )
            db.execute(
                "INSERT INTO payload(rowid, record_id, text_source) VALUES (?, ?, ?)",
                (rowid, *meta[i + j]),
            )
        db.commit()
        rate = (i + B) / max(time.time() - t0, 1e-6)
        print(f"encoded {min(i + B, len(texts))}/{len(texts)} ({rate:.0f}/s)", flush=True)
    n_src = db.execute(
        "SELECT text_source, COUNT(*) FROM payload GROUP BY text_source"
    ).fetchall()
    # provenance meta（Node 查询侧 readMeta 对账依据；fail-fast 见 anima-vector.ts）
    db.executemany(
        "INSERT INTO meta(key, value) VALUES (?, ?)",
        [
            ("model", API_MODEL if USE_API else MODEL),
            ("provider", "api" if USE_API else "local"),
            ("dim", str(actual_dim if actual_dim is not None else DIM)),
            ("count", str(len(texts))),
            ("quant", "int8-signed-maxabs-127"),
            ("distance", "cosine"),
            ("text_sources", json.dumps({k: n for k, n in n_src})),
            ("built_at", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
        ],
    )
    db.commit()
    db.close()
    tmp.replace(OUT)  # 原子落盘
    print(f"payload sources: {n_src}")
    print(f"done: {OUT}")


if __name__ == "__main__":
    main()
