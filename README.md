# smart-translator

**English** | [中文](README_ch.md)

A Tampermonkey userscript that translates any web page, with a GitHub-README mode, plus an optional local helper service:

-   a floating edge button: off / bilingual / Chinese / settings;
-   Google + Microsoft engines raced in parallel, with per-item fallback;
-   incremental DOM scanning, Shadow DOM and portal popups, images and layout left untouched;
-   GitHub README bar: bilingual / CH / EN, and it switches to the Chinese README when the repo has one;
-   an interactive glossary (keep / replace terms), import and export as JSON;
-   right-click an image to translate the text in it (OCR).

The helper service is one Python file. It runs OCR locally (RapidOCR, CPU) and collects frequent English proper nouns from Chinese tech sites into the glossary.

## Files

```
smart-translator/
├── smart_translator.user.js          the userscript (core)
├── glossary_harvester_service.py     local OCR + glossary harvester (optional)
├── smart_translator_glossary.json    a starter glossary to import
├── requirements.txt                  rapidocr-onnxruntime (OCR only)
└── LICENSE
```

## Quick start

1.  Install [Tampermonkey](https://www.tampermonkey.net/), then open the raw file to install it:

    ```
    https://raw.githubusercontent.com/buer5/smart-translator/main/smart_translator.user.js
    ```

2.  (Optional) Start the local helper:

    ```bash
    pip install -r requirements.txt
    python glossary_harvester_service.py
    ```

    It listens on `127.0.0.1:18765` only. Without it, the script still works and image OCR falls back to the public OCR.space API.

3.  Import `smart_translator_glossary.json` from the glossary dialog if you want the starter terms.

## Local service

| Endpoint | Method | What it does |
| --- | --- | --- |
| `/glossary.json` | GET | the harvested glossary; the script merges it at most every 6 hours |
| `/ocr` | POST | image bytes in, text boxes out (RapidOCR) |
| `/health` | GET | `{status, ocr_available}` |

Settings, by environment variable:

| Variable | Default |
| --- | --- |
| `ST_HOST` | `127.0.0.1` |
| `ST_PORT` | `18765` |
| `ST_GLOSSARY_FILE` | `~/smart_translator_glossary.json` |
| `ST_INTERVAL_SEC` | `21600` (one harvest round every 6 hours) |

The harvester asks only a short allowlist of Chinese sites (oschina, cnblogs, infoq.cn, ruanyifeng.com, gitee), one request every 6 seconds, ignoring system proxies.

To use another machine, set `ST_HOST=0.0.0.0` and change the two endpoints at the top of the script. The service has no authentication, so keep it on a trusted network.

## Notes

-   Page text is sent to Google / Microsoft translation endpoints. Don't enable it on pages you can't share.
-   Images sent to the public OCR fallback leave your machine; the local service doesn't.

## License

MIT
