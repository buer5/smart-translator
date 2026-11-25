# smart-translator

[English](README.md) | **中文**

一个 Tampermonkey 油猴脚本：翻译任意网页，并为 GitHub README 提供专用模式；另附可选的本机辅助服务：

-   贴边可拖拽按钮：关闭 / 双语 / 中文 / 设置；
-   Google + Microsoft 双引擎竞速，逐条回退；
-   增量 DOM 扫描，支持 Shadow DOM 与 Portal 弹窗，图片与组件外观不受影响；
-   GitHub README 顶栏：双语 / CH / EN，仓库有中文 README 时自动切换；
-   交互式特殊词库（保留 / 替换），支持 JSON 导入导出；
-   右键图片翻译图中文字（OCR）。

辅助服务是单个 Python 文件：本机运行 OCR（RapidOCR，纯 CPU），并从中文技术站点采集高频英文专有名词写入词库。

## 文件

```
smart-translator/
├── smart_translator.user.js          油猴脚本（核心）
├── glossary_harvester_service.py     本机 OCR + 词库采集服务（可选）
├── smart_translator_glossary.json    可导入的起步词库
├── requirements.txt                  rapidocr-onnxruntime（仅 OCR 需要）
└── LICENSE
```

## 快速开始

1.  安装 [Tampermonkey](https://www.tampermonkey.net/)，打开下面的 raw 地址安装脚本：

    ```
    https://raw.githubusercontent.com/buer5/smart-translator/main/smart_translator.user.js
    ```

2.  （可选）启动本机服务：

    ```bash
    pip install -r requirements.txt
    python glossary_harvester_service.py
    ```

    服务只监听 `127.0.0.1:18765`。不启动也能用，图片 OCR 会回退到公网 OCR.space。

3.  需要起步词库时，在词库弹窗中导入 `smart_translator_glossary.json`。

## 本机服务

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/glossary.json` | GET | 采集到的词库；脚本最多每 6 小时合并一次 |
| `/ocr` | POST | 上传图片，返回文字框（RapidOCR） |
| `/health` | GET | `{status, ocr_available}` |

通过环境变量配置：

| 变量 | 默认值 |
| --- | --- |
| `ST_HOST` | `127.0.0.1` |
| `ST_PORT` | `18765` |
| `ST_GLOSSARY_FILE` | `~/smart_translator_glossary.json` |
| `ST_INTERVAL_SEC` | `21600`（每 6 小时采集一轮） |

采集器只访问少量国内站点白名单（oschina、cnblogs、infoq.cn、ruanyifeng.com、gitee），每 6 秒一次请求，不走系统代理。

若要跨机器使用，设置 `ST_HOST=0.0.0.0` 并修改脚本顶部的两个端点。服务无鉴权，请只放在可信网络。

## 注意

-   页面文字会发送到 Google / Microsoft 翻译接口，不要在不能外传的页面上启用。
-   回退到公网 OCR 时图片会离开本机；本机服务不会。

## 许可

MIT
