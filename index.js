// ============================================================
// Hanime1.me Gopeed 扩展 - 解析 1080p 视频 + 简体中文字幕
// 基于 javaboy2013/gopeed-extension-demo 的四钩子架构
// 参考 acgtools/hanime-hunter 的 Hanime1me Resolver 解析逻辑
// ============================================================

// ---------- 工具函数 ----------

/**
 * 提取视频 ID（从 https://hanime1.me/watch?v=815 中取出 815）
 * 参考：hanime-hunter 的 getSiteAndVID 函数[reference:2]
 */
function extractVideoId(url) {
  const match = url.match(/[?&]v=(\d+)/);
  return match ? match[1] : null;
}

/**
 * 带自定义 Header 的 fetch 封装
 * Cloudflare 保护需要 Cookie + 正确的 User-Agent
 */
async function fetchWithHeaders(url, extraHeaders) {
  const settings = gopeed.settings || {};
  const headers = {
    "User-Agent": settings.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://hanime1.me/",
    ...extraHeaders
  };
  if (settings.cookie) {
    headers["Cookie"] = settings.cookie;
  }
  return fetch(url, { headers, redirect: "follow" });
}

// ---------- 核心解析函数 ----------

/**
 * 从观看页面 HTML 中提取 1080p 视频的 m3u8 链接
 *
 * hanime1.me 的视频源信息嵌入在页面的 JavaScript 变量中，
 * 通常为 var source = "..." 或 data-setup 属性中的 JSON。
 * 参考 hanime-hunter 的 getDLInfo 实现[reference:3]
 */
function extractVideoSources(html, videoId) {
  const sources = [];

  // 策略 1：匹配常见的 m3u8 URL 模式（含 1080 / 720 / 480 等分辨率标识）
  const m3u8Regex = /https?:\/\/[^"'\s]+?\.m3u8[^"'\s]*/g;
  const m3u8Matches = html.match(m3u8Regex) || [];

  for (const url of m3u8Matches) {
    let quality = "unknown";
    if (/1080/.test(url)) quality = "1080p";
    else if (/720/.test(url)) quality = "720p";
    else if (/480/.test(url)) quality = "480p";
    else if (/360/.test(url)) quality = "360p";

    sources.push({ url, quality });
  }

  // 策略 2：解析 data-setup JSON（hanime1.me 部分页面使用此格式）
  const dataSetupMatch = html.match(/data-setup=["']([^"']+)["']/);
  if (dataSetupMatch) {
    try {
      const decoded = decodeURIComponent(dataSetupMatch[1]);
      const setupData = JSON.parse(decoded);
      if (setupData.sources && Array.isArray(setupData.sources)) {
        for (const src of setupData.sources) {
          const srcUrl = src.file || src.src || src.url;
          if (srcUrl && srcUrl.includes(".m3u8")) {
            sources.push({
              url: srcUrl,
              quality: src.label || src.quality || "unknown"
            });
          }
        }
      }
    } catch (e) {
      gopeed.logger.debug("data-setup JSON 解析失败: " + e.message);
    }
  }

  // 策略 3：匹配 var source = "..." 或 source: "..." 格式
  const varSourceRegex = /(?:var\s+source|source\s*[:=])\s*["']([^"']*\.m3u8[^"']*)["']/gi;
  let varMatch;
  while ((varMatch = varSourceRegex.exec(html)) !== null) {
    const url = varMatch[1];
    let quality = "unknown";
    if (/1080/.test(url)) quality = "1080p";
    else if (/720/.test(url)) quality = "720p";
    sources.push({ url, quality });
  }

  // 去重
  const seen = new Set();
  return sources.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

/**
 * 从观看页面 HTML 中提取字幕文件链接
 *
 * hanime1.me 的字幕通常以 <track> 标签嵌入，或通过 API 返回。
 * 简体中文的 srclang 一般为 "zh-CN" 或 "zh"
 */
function extractSubtitles(html) {
  const subtitles = [];

  // 策略 1：<track> 标签
  const trackRegex = /<track[^>]+>/gi;
  const trackMatches = html.match(trackRegex) || [];

  for (const tag of trackMatches) {
    const srcMatch = tag.match(/src=["']([^"']+)["']/);
    const langMatch = tag.match(/srclang=["']([^"']+)["']/);
    const labelMatch = tag.match(/label=["']([^"']+)["']/);

    if (srcMatch) {
      const src = srcMatch[1];
      const lang = langMatch ? langMatch[1].toLowerCase() : "";
      const label = labelMatch ? labelMatch[1] : "";

      // 优先简体中文
      const isSimpChinese =
        lang === "zh-cn" || lang === "zh-hans" || lang === "zh" ||
        label.includes("简体") || label.includes("中文") ||
        src.includes("zh-cn") || src.includes("zh-hans");

      if (isSimpChinese) {
        subtitles.push({
          url: src.startsWith("http") ? src : "https:" + src,
          lang: lang || "zh-CN",
          label: label || "简体中文",
          format: src.endsWith(".vtt") ? "vtt" : "srt"
        });
      }
    }
  }

  // 策略 2：匹配 JSON 中的 subtitle 字段
  const subtitleJsonRegex = /["']subtitle[s]?["']\s*:\s*(\[[^\]]*\]|\{[^}]*\})/gi;
  let jsonMatch;
  while ((jsonMatch = subtitleJsonRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const url = item.url || item.src || item.file;
        const lang = (item.lang || item.language || "").toLowerCase();
        if (url && (lang.includes("zh") || (item.label || "").includes("中文"))) {
          subtitles.push({
            url: url.startsWith("http") ? url : "https:" + url,
            lang: lang || "zh-CN",
            label: item.label || "简体中文",
            format: url.endsWith(".vtt") ? "vtt" : "srt"
          });
        }
      }
    } catch (e) {
      // 忽略解析失败
    }
  }

  // 去重
  const seen = new Set();
  return subtitles.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

/**
 * 从页面标题中提取视频名称（用于生成文件名）
 */
function extractTitle(html) {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    return titleMatch[1].replace(/\s*[-|]\s*Hanime1.*$/i, "").trim();
  }
  const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  return ogTitleMatch ? ogTitleMatch[1].trim() : "hanime1_video";
}

// ---------- 钩子实现 ----------

/**
 * onResolve：创建任务时的解析入口
 * 输入：ctx.req.url（用户粘贴的 hanime1.me 观看页 URL）
 * 输出：ctx.res（包含文件列表的 Resource 对象）
 */
gopeed.events.onResolve(async function (ctx) {
  const url = ctx.req.url;
  gopeed.logger.info("开始解析 Hanime1 视频: " + url);

  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new MessageError("无法从 URL 中提取视频 ID，请确认链接格式为 https://hanime1.me/watch?v=数字");
  }

  gopeed.logger.info("视频 ID: " + videoId);

  // 1. 获取观看页面 HTML
  let html;
  try {
    const resp = await fetchWithHeaders(url);
    if (!resp.ok) {
      throw new Error("HTTP " + resp.status);
    }
    html = await resp.text();
  } catch (e) {
    throw new MessageError("获取页面失败（可能需要配置 Cookie）：" + e.message);
  }

  // 2. 提取标题
  const title = extractTitle(html);
  gopeed.logger.info("视频标题: " + title);

  // 3. 提取视频源
  let sources = extractVideoSources(html, videoId);
  gopeed.logger.info("发现 " + sources.length + " 个视频源");

  if (sources.length === 0) {
    throw new MessageError("未找到视频源，页面结构可能已变更或需要登录 Cookie");
  }

  // 4. 选择 1080p（优先精确匹配，其次降级）
  let selectedVideo = sources.find(s => s.quality === "1080p");
  if (!selectedVideo) {
    // 降级：按分辨率从高到低选择
    const priority = ["720p", "480p", "360p", "unknown"];
    for (const q of priority) {
      selectedVideo = sources.find(s => s.quality === q);
      if (selectedVideo) {
        gopeed.logger.warn("未找到 1080p 源，降级为 " + selectedVideo.quality);
        break;
      }
    }
  }
  if (!selectedVideo) {
    throw new MessageError("无法确定可用的视频源");
  }
  gopeed.logger.info("已选择视频源: " + selectedVideo.quality + " -> " + selectedVideo.url);

  // 5. 提取字幕
  const subtitles = extractSubtitles(html);
  gopeed.logger.info("发现 " + subtitles.length + " 个字幕文件");

  // 选择简体中文字幕
  let selectedSubtitle = subtitles.find(s =>
    s.lang === "zh-cn" || s.lang === "zh-hans" || s.lang === "zh"
  ) || subtitles[0]; // 没有精确匹配时取第一个

  // 6. 构建返回的文件列表
  const files = [
    {
      name: title + "_" + selectedVideo.quality + ".m3u8",
      url: selectedVideo.url,
      size: 0
    }
  ];

  if (selectedSubtitle) {
    const ext = selectedSubtitle.format || "vtt";
    files.push({
      name: title + "_简体中文." + ext,
      url: selectedSubtitle.url,
      size: 0
    });
    gopeed.logger.info("已选择字幕: " + selectedSubtitle.label + " -> " + selectedSubtitle.url);
  } else {
    gopeed.logger.warn("未找到简体中文字幕文件");
  }

  // 7. 写入解析结果
  ctx.res = {
    name: title,
    files: files
  };
});

/**
 * onStart：下载开始前，补充请求头
 * 确保 m3u8 和字幕请求携带正确的 Referer 和 Cookie
 */
gopeed.events.onStart(async function (ctx) {
  const settings = gopeed.settings || {};
  const req = ctx.task.meta.req;

  // 确保 Headers 对象存在
  if (!req.headers) {
    req.headers = {};
  }

  // 注入必要的 Header
  req.headers["Referer"] = "https://hanime1.me/";
  req.headers["User-Agent"] = settings.userAgent ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  if (settings.cookie) {
    req.headers["Cookie"] = settings.cookie;
  }

  gopeed.logger.info("onStart: 已为任务 " + ctx.task.id + " 注入请求头");
});

/**
 * onError：下载出错时的处理
 */
gopeed.events.onError(async function (ctx) {
  gopeed.logger.error("下载出错 [" + ctx.task.id + "]: " + ctx.error.message);

  // 如果是因为 Cloudflare 拦截（403），提示用户更新 Cookie
  if (ctx.error.message.includes("403") || ctx.error.message.includes("Forbidden")) {
    gopeed.logger.warn("检测到 403 错误，请检查扩展设置中的 Cookie 是否有效");
  }
});

/**
 * onDone：下载完成后的回调
 */
gopeed.events.onDone(async function (ctx) {
  gopeed.logger.info("下载完成: " + ctx.task.meta.res.name);
});
