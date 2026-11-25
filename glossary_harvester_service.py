#!/usr/bin/env python3
"""
Smart Translator 后台低频专用名词采集服务（本机运行）
特性：
1. 强制绕过所有系统代理（ProxyHandler({}) + 清除代理环境变量），直连国内技术站点
2. 严格限制仅访问国内中文技术站点白名单，绝不访问国外站点
3. 低频温和采集（单请求间隔 >= 5 秒，每 6 小时仅运行一轮，极低 CPU/内存占用）
4. 自动从中文技术文章中提取高频英文专用名词/缩写/AI 模型名/框架名，去重合并至本地 JSON
5. 内置轻量 HTTP 服务（默认 127.0.0.1:18765/glossary.json），供 Tampermonkey 插件静默同步
"""

import json
import os
import re
import threading
import time
import urllib.request
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# 清除进程内代理环境变量，确保任何底层库都不走系统代理
for _proxy_var in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(_proxy_var, None)

LISTEN_HOST = os.environ.get("ST_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("ST_PORT", "18765"))
GLOSSARY_FILE = os.environ.get("ST_GLOSSARY_FILE", os.path.expanduser("~/smart_translator_glossary.json"))
HARVEST_INTERVAL_SEC = int(os.environ.get("ST_INTERVAL_SEC", str(6 * 3600)))  # 默认 6 小时一轮
REQUEST_DELAY_SEC = 6.0  # 每次请求间隔 6 秒（低频温和）
MAX_DYNAMIC_KEEP_TERMS = 600

# 严格国内站点白名单（仅访问国内中文技术资讯/开源社区 RSS 与首页，绝不访问国外站点）
DOMESTIC_ALLOWLIST_DOMAINS = {
    "www.oschina.net",
    "oschina.net",
    "www.cnblogs.com",
    "feed.cnblogs.com",
    "www.infoq.cn",
    "gitee.com",
    "segmentfault.com",
    "www.ruanyifeng.com",
}

DOMESTIC_SEED_URLS = [
    "https://www.oschina.net/news/rss",
    "https://feed.cnblogs.com/blog/sitehome/rss",
    "https://www.infoq.cn/feed",
    "https://www.ruanyifeng.com/blog/atom.xml",
    "https://gitee.com/explore",
]

# 常见普通英文停用词（绝不纳入专用排除词库）
COMMON_STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "your", "have", "will",
    "about", "more", "when", "what", "which", "their", "there", "been", "were",
    "they", "them", "then", "than", "into", "over", "also", "only", "just",
    "like", "make", "made", "using", "used", "uses", "user", "users", "data",
    "code", "file", "files", "page", "site", "link", "list", "text", "time",
    "year", "month", "date", "news", "blog", "post", "read", "view", "home",
    "help", "info", "menu", "main", "test", "demo", "free", "open", "work",
    "best", "good", "high", "fast", "easy", "full", "next", "last", "part",
    "step", "note", "tips", "here", "some", "many", "most", "much", "very",
    "each", "both", "such", "well", "back", "down", "even", "find", "give",
    "know", "need", "take", "want", "does", "done", "true", "false", "null",
    "none", "void", "auto", "type", "name", "size", "line", "item", "self",
    "http", "https", "www", "com", "org", "net", "html", "xml", "utf", "rss",
    "href", "src", "alt", "img", "div", "span", "cdata", "title", "guid",
    "pubdate", "description", "author", "category", "content", "summary",
    "updated", "published", "entry", "feed", "channel", "version", "encoding",
    "charset", "style", "class", "width", "height", "border", "margin", "padding",
    "color", "font", "block", "inline", "flex", "grid", "table", "tbody", "thead",
    "script", "window", "document", "function", "return", "const", "export",
    "import", "default", "async", "await", "class", "public", "private", "static",
    "string", "number", "boolean", "object", "array", "error", "value", "index",
    "update", "create", "delete", "select", "insert", "where", "order", "group",
    "build", "start", "check", "debug", "watch", "clean", "setup", "login",
    "share", "click", "press", "enter", "close", "focus", "hover", "input",
    "output", "query", "param", "state", "props", "event", "store", "cache",
    "local", "cloud", "model", "agent", "prompt", "server", "client", "system",
    "service", "project", "support", "feature", "release", "version", "install",
    "config", "option", "method", "module", "plugin", "driver", "engine", "studio",
    "github", "gitee", "csdn", "zhihu", "juejin", "cnblogs", "oschina", "infoq",
}

# 匹配中文语境中嵌入的典型英文专有名词（全大写缩写、驼峰框架名、带版本号/连字符的模型名）
PROPER_NOUN_PATTERNS = [
    re.compile(r"(?<![A-Za-z0-9_])([A-Z]{2,6}(?:\d+)?)(?![A-Za-z0-9_])"),                 # LLM, vLLM, CUDA, RAG, MCP, K8S
    re.compile(r"(?<![A-Za-z0-9_])([A-Z][a-z]+[A-Z][A-Za-z0-9.+-]{1,24})(?![A-Za-z0-9_])"),  # DeepSeek, LangChain, PyTorch, Next.js
    re.compile(r"(?<![A-Za-z0-9_])([A-Za-z]{2,14}[-.][A-Za-z0-9.+-]{1,12})(?![A-Za-z0-9_])"), # GPT-4o, Next.js, Qwen2.5, Vue.js
    re.compile(r"[\u4e00-\u9fff]\s*([A-Z][a-z]{2,18})\s*[\u4e00-\u9fff]"),               # 中文夹杂的首字母大写品牌词（如“基于 Rust 开发”）
]

# 直连 opener（空 ProxyHandler 强制不走系统代理）
DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

glossary_lock = threading.Lock()
glossary_data = {
    "version": "3.0.0",
    "updated_at": "",
    "keep": [],
    "replace": {},
}


def load_glossary_file():
    global glossary_data
    with glossary_lock:
        if os.path.exists(GLOSSARY_FILE):
            try:
                with open(GLOSSARY_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    glossary_data["keep"] = list(dict.fromkeys(str(x).strip() for x in data.get("keep", []) if str(x).strip()))
                    glossary_data["replace"] = dict(data.get("replace", {})) if isinstance(data.get("replace"), dict) else {}
                    glossary_data["updated_at"] = data.get("updated_at", "")
            except Exception as e:
                print(f"[Harvester] Failed to load {GLOSSARY_FILE}: {e}")


def save_glossary_file():
    with glossary_lock:
        os.makedirs(os.path.dirname(os.path.abspath(GLOSSARY_FILE)), exist_ok=True)
        tmp = GLOSSARY_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(glossary_data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, GLOSSARY_FILE)


def fetch_domestic_direct(url):
    host = (urlparse(url).hostname or "").lower()
    if host not in DOMESTIC_ALLOWLIST_DOMAINS:
        raise ValueError(f"Blocked non-domestic domain: {host}")

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "SmartTranslator-GlossaryHarvester/3.0 (Local-LowFreq)",
            "Accept": "application/rss+xml, application/xml, text/xml, text/html;q=0.9",
        },
    )
    with DIRECT_OPENER.open(req, timeout=12) as resp:
        raw = resp.read(512 * 1024)  # 限制单页最大读取 512KB
        return raw.decode("utf-8", errors="ignore")


def strip_markup(text):
    text = re.sub(r"<script[\s\S]*?</script>", " ", text, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"<[^>]+>", " ", text)
    return text


def extract_proper_nouns(text):
    clean = strip_markup(text)
    # 仅处理含中文内容的技术文章，确保提取的是中文语境中的英文专有名词
    if len(re.findall(r"[\u4e00-\u9fff]", clean)) < 80:
        return Counter()

    counts = Counter()
    for pat in PROPER_NOUN_PATTERNS:
        for m in pat.finditer(clean):
            term = m.group(1).strip(".,:;!?()[]{}\"'`")
            if len(term) < 2 or len(term) > 28:
                continue
            low = term.lower()
            if low in COMMON_STOPWORDS:
                continue
            if re.fullmatch(r"\d+(\.\d+)*", term):
                continue
            # 过滤纯文件扩展名或随机十六进制串
            if re.fullmatch(r"[0-9a-f]{6,}", low):
                continue
            counts[term] += 1
    return counts


def run_harvest_cycle():
    print(f"[Harvester] Starting low-frequency domestic harvest cycle at {time.strftime('%Y-%m-%d %H:%M:%S')}")
    total_counts = Counter()

    for url in DOMESTIC_SEED_URLS:
        try:
            body = fetch_domestic_direct(url)
            c = extract_proper_nouns(body)
            total_counts.update(c)
            print(f"[Harvester] Fetched {url}: {len(c)} candidates")
        except Exception as e:
            print(f"[Harvester] Skip {url}: {e}")
        time.sleep(REQUEST_DELAY_SEC)

    # 仅收录在本轮出现 >= 2 次的高置信度专有名词，避免噪声污染
    qualified = [term for term, cnt in total_counts.most_common(120) if cnt >= 2]
    if not qualified:
        return

    with glossary_lock:
        existing_lower = {k.lower() for k in glossary_data["keep"]}
        existing_lower.update(k.lower() for k in glossary_data["replace"].keys())
        added = 0
        for term in qualified:
            if term.lower() not in existing_lower and len(glossary_data["keep"]) < MAX_DYNAMIC_KEEP_TERMS:
                glossary_data["keep"].append(term)
                existing_lower.add(term.lower())
                added += 1
        glossary_data["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    if added > 0:
        save_glossary_file()
        print(f"[Harvester] Added {added} new proper nouns -> saved to {GLOSSARY_FILE}")
    else:
        print("[Harvester] No new terms added this cycle.")


def harvester_loop():
    while True:
        try:
            run_harvest_cycle()
        except Exception as e:
            print(f"[Harvester] Cycle error: {e}")
        time.sleep(HARVEST_INTERVAL_SEC)


# ---- 轻量本地 RapidOCR 引擎（懒加载、纯 CPU、线程安全、未安装时优雅降级 503） ----
ocr_lock = threading.Lock()
ocr_engine = None
ocr_init_attempted = False
ocr_init_error = ""
MAX_OCR_UPLOAD_BYTES = 8 * 1024 * 1024


def get_ocr_engine():
    global ocr_engine, ocr_init_attempted, ocr_init_error
    if ocr_engine is not None:
        return ocr_engine
    with ocr_lock:
        if ocr_engine is not None:
            return ocr_engine
        if ocr_init_attempted:
            return None
        ocr_init_attempted = True
        try:
            from rapidocr_onnxruntime import RapidOCR
            ocr_engine = RapidOCR()
            print("[OCR] RapidOCR initialized successfully (CPU ONNX).")
            return ocr_engine
        except Exception as e:
            ocr_init_error = str(e)
            print(f"[OCR] RapidOCR unavailable ({e}); /ocr will return 503 so clients fall back to public OCR.")
            return None


def run_local_ocr_bytes(img_bytes):
    engine = get_ocr_engine()
    if engine is None:
        return None, ocr_init_error or "rapidocr-onnxruntime not installed"
    with ocr_lock:
        result, _ = engine(img_bytes)
    boxes = []
    if result:
        for item in result:
            if not item or len(item) < 2:
                continue
            pts = item[0]
            text = str(item[1] or "").strip()
            score = float(item[2]) if len(item) >= 3 and item[2] is not None else 1.0
            if not text or score < 0.45:
                continue
            xs = [float(p[0]) for p in pts]
            ys = [float(p[1]) for p in pts]
            x0, x1 = min(xs), max(xs)
            y0, y1 = min(ys), max(ys)
            if x1 > x0 and y1 > y0:
                boxes.append({
                    "text": text,
                    "x": round(x0, 1),
                    "y": round(y0, 1),
                    "w": round(x1 - x0, 1),
                    "h": round(y1 - y0, 1),
                    "score": round(score, 3),
                })
    return boxes, ""


class GlossaryHttpHandler(BaseHTTPRequestHandler):
    def _send_json(self, status, obj, cache_control=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        if cache_control:
            self.send_header("Cache-Control", cache_control)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/glossary.json", "/"):
            with glossary_lock:
                snapshot = dict(glossary_data)
            self._send_json(200, snapshot, cache_control="max-age=1800")
        elif path == "/health":
            self._send_json(200, {
                "status": "ok",
                "ocr_available": get_ocr_engine() is not None,
            })
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path != "/ocr":
            self._send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self._send_json(400, {"ok": False, "error": "empty body"})
            return
        if length > MAX_OCR_UPLOAD_BYTES:
            self._send_json(413, {"ok": False, "error": "image too large"})
            return

        img_bytes = self.rfile.read(length)
        try:
            boxes, err = run_local_ocr_bytes(img_bytes)
            if boxes is None:
                self._send_json(503, {"ok": False, "error": err})
                return
            self._send_json(200, {"ok": True, "engine": "rapidocr", "boxes": boxes})
        except Exception as e:
            self._send_json(500, {"ok": False, "error": str(e)})

    def log_message(self, format, *args):
        pass


def main():
    load_glossary_file()
    save_glossary_file()
    t = threading.Thread(target=harvester_loop, daemon=True)
    t.start()
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), GlossaryHttpHandler)
    print(f"[Harvester] Serving LAN glossary at http://{LISTEN_HOST}:{LISTEN_PORT}/glossary.json (no system proxy)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()