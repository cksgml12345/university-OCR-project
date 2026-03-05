const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const DEFAULT_PORT = 5001;
const DEFAULT_UPLOAD_ROOT = path.join(__dirname, "uploads");
const DEFAULT_FRONTEND_BUILD_PATH = path.resolve(__dirname, "../frontend/build");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
const OCR_LANG = process.env.OCR_LANG || "eng";
let tesseractModulePromise = null;

const sortNaturally = (list) =>
  [...list].sort((a, b) => a.localeCompare(b, "ko", { numeric: true, sensitivity: "base" }));

const parseBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const getTesseract = async () => {
  if (!tesseractModulePromise) {
    tesseractModulePromise = Promise.resolve().then(() => require("tesseract.js"));
  }
  return tesseractModulePromise;
};

const defaultOcrExtractor = async (imagePath) => {
  const Tesseract = await getTesseract();
  const result = await Tesseract.recognize(imagePath, OCR_LANG);
  return String(result?.data?.text || "").trim();
};

const createApp = (options = {}) => {
  const uploadRoot = options.uploadRoot || process.env.UPLOAD_ROOT || DEFAULT_UPLOAD_ROOT;
  const frontendBuildPath = options.frontendBuildPath || DEFAULT_FRONTEND_BUILD_PATH;
  const serveFrontend = options.serveFrontend !== false;
  const extractTextFromImageLocal = options.ocrExtractor || defaultOcrExtractor;
  const startedAt = options.startedAt || new Date();

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/uploads", express.static(uploadRoot));

  fs.mkdirSync(uploadRoot, { recursive: true });

  const resolveBookPath = (bookName) => {
    let decoded = "";
    try {
      decoded = decodeURIComponent(bookName || "");
    } catch (error) {
      return null;
    }
    const normalizedName = path.basename(decoded).trim();
    const resolved = path.resolve(uploadRoot, normalizedName);

    if (!normalizedName || !resolved.startsWith(uploadRoot + path.sep)) {
      return null;
    }

    return { normalizedName, resolved };
  };

  const isImageFile = (fileName) => IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());

  const getProcessStatePath = (bookPath) => path.join(bookPath, ".process-state.json");

  const readProcessedPages = (bookPath, allPages) => {
    const statePath = getProcessStatePath(bookPath);
    if (!fs.existsSync(statePath)) {
      return [];
    }

    try {
      const raw = fs.readFileSync(statePath, "utf8");
      const parsed = JSON.parse(raw);
      const processed = Array.isArray(parsed?.processedPages)
        ? parsed.processedPages.map((page) => String(page))
        : [];
      const allSet = new Set(allPages);
      return sortNaturally(processed.filter((page) => allSet.has(page)));
    } catch (error) {
      return [];
    }
  };

  const writeProcessedPages = (bookPath, processedPages) => {
    const statePath = getProcessStatePath(bookPath);
    const payload = {
      processedPages: sortNaturally(processedPages),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(statePath, JSON.stringify(payload, null, 2), "utf8");
  };

  const getImagePages = (bookPath) => {
    const files = fs.readdirSync(bookPath);
    return sortNaturally(files.filter((file) => isImageFile(file)));
  };

  const getOcrTextPath = (bookPath, pageName) =>
    path.join(bookPath, "ocr", `${path.parse(pageName).name}.txt`);

  const resolveTargetPages = (allPages, requestPages) => {
    let targetPages = allPages;
    if (requestPages && requestPages.length > 0) {
      const allSet = new Set(allPages);
      targetPages = sortNaturally(
        requestPages.filter((page, index) => allSet.has(page) && requestPages.indexOf(page) === index)
      );
    }
    return targetPages;
  };

  const withSkipProcessed = (bookPath, pages, includeProcessed) => {
    if (includeProcessed) {
      return { targetPages: pages, skippedPages: [] };
    }
    const skippedPages = [];
    const targetPages = [];
    for (const pageName of pages) {
      const txtPath = getOcrTextPath(bookPath, pageName);
      if (fs.existsSync(txtPath)) {
        skippedPages.push(pageName);
      } else {
        targetPages.push(pageName);
      }
    }
    return { targetPages, skippedPages };
  };

  const updateProcessedStateFromOcr = (bookPath, allPages) => {
    const ocrPages = allPages.filter((page) => fs.existsSync(getOcrTextPath(bookPath, page)));
    writeProcessedPages(bookPath, ocrPages);
    return sortNaturally(ocrPages);
  };

  const runOcrForPages = async (bookPath, pages, onProgress) => {
    const ocrRoot = path.join(bookPath, "ocr");
    fs.mkdirSync(ocrRoot, { recursive: true });
    const ocrResults = [];

    for (let index = 0; index < pages.length; index += 1) {
      const pageName = pages[index];
      const imagePath = path.join(bookPath, pageName);
      const text = await extractTextFromImageLocal(imagePath);
      const txtPath = getOcrTextPath(bookPath, pageName);
      fs.writeFileSync(txtPath, text, "utf8");
      ocrResults.push({
        page: pageName,
        textFile: path.basename(txtPath),
        charCount: text.length,
      });
      if (onProgress) {
        onProgress({
          page: pageName,
          done: index + 1,
          total: pages.length,
          percent: pages.length > 0 ? Math.round(((index + 1) * 100) / pages.length) : 100,
        });
      }
    }

    return ocrResults;
  };

  const storage = multer.diskStorage({
    destination: function destination(req, file, cb) {
      const relativePath = file.originalname.replace(/\\/g, "/");
      const segments = relativePath.split("/").filter(Boolean);
      const firstSegment = segments[0] || "";
      const fromPath = segments.length > 1 ? firstSegment : "";
      const requestedBookName = path.basename(String(req.body?.bookName || "")).trim();
      const bookName = path.basename(fromPath || requestedBookName || "untitled").trim();
      const uploadPath = path.join(uploadRoot, bookName || "untitled");

      fs.mkdirSync(uploadPath, { recursive: true });
      cb(null, uploadPath);
    },
    filename: function filename(req, file, cb) {
      cb(null, path.basename(file.originalname.replace(/\\/g, "/")));
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: 15 * 1024 * 1024, files: 5000 },
  });

  app.post("/upload", upload.array("files"), (req, res) => {
    const affectedBooks = new Set();

    for (const file of req.files || []) {
      const bookName = path.basename(file.destination || "").trim();
      if (bookName) {
        affectedBooks.add(bookName);
      }
    }

    res.json({
      message: "업로드 완료",
      uploadedFiles: (req.files || []).length,
      books: sortNaturally([...affectedBooks]),
    });
  });

  app.get("/books", (req, res) => {
    if (!fs.existsSync(uploadRoot)) {
      return res.json([]);
    }

    const bookDirectories = fs
      .readdirSync(uploadRoot)
      .filter((entry) => fs.statSync(path.join(uploadRoot, entry)).isDirectory());

    const books = sortNaturally(bookDirectories).map((bookName) => {
      const bookPath = path.join(uploadRoot, bookName);
      const pageCount = getImagePages(bookPath).length;
      const updatedAt = fs.statSync(bookPath).mtime;
      return { name: bookName, pageCount, updatedAt };
    });

    return res.json(books);
  });

  app.get("/health", (req, res) => {
    return res.json({
      ok: true,
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
      startedAt: startedAt.toISOString(),
      now: new Date().toISOString(),
    });
  });

  app.get("/books/:bookName", (req, res) => {
    const resolved = resolveBookPath(req.params.bookName);
    if (!resolved) {
      return res.status(400).json({ message: "잘못된 책 이름입니다." });
    }

    const { normalizedName, resolved: bookPath } = resolved;
    if (!fs.existsSync(bookPath)) {
      return res.status(404).json({ message: "책 없음" });
    }

    const pages = getImagePages(bookPath);
    const processedPages = readProcessedPages(bookPath, pages);
    const ocrPages = pages.filter((page) => fs.existsSync(getOcrTextPath(bookPath, page)));

    return res.json({
      bookName: normalizedName,
      pageCount: pages.length,
      pages,
      processedPages,
      ocrPages,
      allOcrReady: pages.length > 0 && ocrPages.length === pages.length,
    });
  });

  app.delete("/books/:bookName", (req, res) => {
    const resolved = resolveBookPath(req.params.bookName);
    if (!resolved) {
      return res.status(400).json({ message: "잘못된 책 이름입니다." });
    }
    if (!fs.existsSync(resolved.resolved)) {
      return res.status(404).json({ message: "책 없음" });
    }

    fs.rmSync(resolved.resolved, { recursive: true, force: true });
    return res.json({
      message: "책 삭제 완료",
      bookName: resolved.normalizedName,
      deletedAt: new Date().toISOString(),
    });
  });

  app.post("/process/:bookName", async (req, res) => {
    const resolved = resolveBookPath(req.params.bookName);
    if (!resolved) {
      return res.status(400).json({ message: "잘못된 책 이름입니다." });
    }
    if (!fs.existsSync(resolved.resolved)) {
      return res.status(404).json({ message: "책 없음" });
    }

    const allPages = getImagePages(resolved.resolved);
    const requestPages = Array.isArray(req.body?.pages) ? req.body.pages.map((page) => String(page)) : null;
    const includeProcessed = parseBoolean(req.body?.includeProcessed, false);
    const requestedPages = resolveTargetPages(allPages, requestPages);
    const { targetPages, skippedPages } = withSkipProcessed(
      resolved.resolved,
      requestedPages,
      includeProcessed
    );

    if (!requestedPages.length) {
      return res.status(400).json({ message: "처리할 페이지가 없습니다." });
    }

    try {
      const ocrResults = await runOcrForPages(resolved.resolved, targetPages);
      const processedAfter = updateProcessedStateFromOcr(resolved.resolved, allPages);

      return res.json({
        message: targetPages.length ? "OCR 공정 완료" : "처리할 신규 페이지가 없습니다.",
        mode: requestPages ? "selected-pages" : "whole-book",
        bookName: resolved.normalizedName,
        includeProcessed,
        processedPages: targetPages.length,
        skippedPages,
        pages: targetPages,
        totalProcessedPages: processedAfter.length,
        processedPagesList: processedAfter,
        ocrOutputDir: "ocr",
        ocrResults,
        processedAt: new Date().toISOString(),
      });
    } catch (error) {
      return res.status(502).json({
        message: "OCR 실행 중 오류가 발생했습니다.",
        detail: error.message,
        hint: "로컬 OCR 엔진 초기 다운로드/언어 데이터 로딩 중 실패했을 수 있습니다. 네트워크 연결 또는 OCR_LANG 값을 확인해 주세요.",
      });
    }
  });

  app.get("/process-stream/:bookName", async (req, res) => {
    const resolved = resolveBookPath(req.params.bookName);
    if (!resolved) {
      return res.status(400).json({ message: "잘못된 책 이름입니다." });
    }
    if (!fs.existsSync(resolved.resolved)) {
      return res.status(404).json({ message: "책 없음" });
    }

    const allPages = getImagePages(resolved.resolved);
    const rawPages = req.query?.pages;
    const includeProcessed = parseBoolean(req.query?.includeProcessed, false);
    const requestPages = rawPages
      ? String(rawPages)
          .split(",")
          .map((page) => page.trim())
          .filter(Boolean)
      : null;
    const requestedPages = resolveTargetPages(allPages, requestPages);
    if (!requestedPages.length) {
      return res.status(400).json({ message: "처리할 페이지가 없습니다." });
    }

    const { targetPages, skippedPages } = withSkipProcessed(
      resolved.resolved,
      requestedPages,
      includeProcessed
    );

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const sendEvent = (type, payload) => {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    let closed = false;
    req.on("close", () => {
      closed = true;
    });

    sendEvent("start", {
      bookName: resolved.normalizedName,
      total: targetPages.length,
      mode: requestPages ? "selected-pages" : "whole-book",
      includeProcessed,
      skippedPages,
    });

    try {
      await runOcrForPages(resolved.resolved, targetPages, (progress) => {
        if (!closed) {
          sendEvent("progress", progress);
        }
      });
      if (closed) {
        return;
      }

      const processedAfter = updateProcessedStateFromOcr(resolved.resolved, allPages);
      sendEvent("complete", {
        message: targetPages.length ? "OCR 공정 완료" : "처리할 신규 페이지가 없습니다.",
        mode: requestPages ? "selected-pages" : "whole-book",
        bookName: resolved.normalizedName,
        includeProcessed,
        processedPages: targetPages.length,
        skippedPages,
        pages: targetPages,
        totalProcessedPages: processedAfter.length,
        processedPagesList: processedAfter,
        processedAt: new Date().toISOString(),
      });
      return res.end();
    } catch (error) {
      sendEvent("error", {
        message: "OCR 실행 중 오류가 발생했습니다.",
        detail: error.message,
      });
      return res.end();
    }
  });

  app.get("/books/:bookName/ocr/:pageName", (req, res) => {
    const resolved = resolveBookPath(req.params.bookName);
    if (!resolved) {
      return res.status(400).json({ message: "잘못된 책 이름입니다." });
    }
    if (!fs.existsSync(resolved.resolved)) {
      return res.status(404).json({ message: "책 없음" });
    }

    const pageName = path.basename(String(req.params.pageName || "")).trim();
    const allPages = getImagePages(resolved.resolved);
    if (!allPages.includes(pageName)) {
      return res.status(404).json({ message: "페이지 없음" });
    }

    const txtPath = getOcrTextPath(resolved.resolved, pageName);
    if (!fs.existsSync(txtPath)) {
      return res.status(404).json({ message: "해당 페이지 OCR 결과가 없습니다." });
    }

    const text = fs.readFileSync(txtPath, "utf8");
    return res.json({ bookName: resolved.normalizedName, pageName, text });
  });

  app.put("/books/:bookName/ocr/:pageName", (req, res) => {
    const resolved = resolveBookPath(req.params.bookName);
    if (!resolved) {
      return res.status(400).json({ message: "잘못된 책 이름입니다." });
    }
    if (!fs.existsSync(resolved.resolved)) {
      return res.status(404).json({ message: "책 없음" });
    }

    const pageName = path.basename(String(req.params.pageName || "")).trim();
    const allPages = getImagePages(resolved.resolved);
    if (!allPages.includes(pageName)) {
      return res.status(404).json({ message: "페이지 없음" });
    }

    if (typeof req.body?.text !== "string") {
      return res.status(400).json({ message: "text는 문자열이어야 합니다." });
    }

    const ocrRoot = path.join(resolved.resolved, "ocr");
    fs.mkdirSync(ocrRoot, { recursive: true });
    const txtPath = getOcrTextPath(resolved.resolved, pageName);
    fs.writeFileSync(txtPath, req.body.text, "utf8");
    const processedAfter = updateProcessedStateFromOcr(resolved.resolved, allPages);

    return res.json({
      message: "OCR 텍스트 저장 완료",
      bookName: resolved.normalizedName,
      pageName,
      charCount: req.body.text.length,
      totalProcessedPages: processedAfter.length,
      processedPagesList: processedAfter,
      updatedAt: new Date().toISOString(),
    });
  });

  app.get("/books/:bookName/search", (req, res) => {
    const resolved = resolveBookPath(req.params.bookName);
    if (!resolved) {
      return res.status(400).json({ message: "잘못된 책 이름입니다." });
    }
    if (!fs.existsSync(resolved.resolved)) {
      return res.status(404).json({ message: "책 없음" });
    }

    const query = String(req.query?.q || "").trim();
    if (!query) {
      return res.status(400).json({ message: "검색어 q가 필요합니다." });
    }

    const pages = getImagePages(resolved.resolved);
    const loweredQuery = query.toLowerCase();
    const matches = [];
    for (const pageName of pages) {
      const txtPath = getOcrTextPath(resolved.resolved, pageName);
      if (!fs.existsSync(txtPath)) {
        continue;
      }
      const text = fs.readFileSync(txtPath, "utf8");
      const lowered = text.toLowerCase();
      let index = lowered.indexOf(loweredQuery);
      let count = 0;
      while (index !== -1) {
        count += 1;
        index = lowered.indexOf(loweredQuery, index + loweredQuery.length);
      }
      if (count > 0) {
        const firstIndex = lowered.indexOf(loweredQuery);
        const start = Math.max(0, firstIndex - 30);
        const end = Math.min(text.length, firstIndex + query.length + 30);
        matches.push({
          page: pageName,
          occurrences: count,
          excerpt: text.slice(start, end).replace(/\s+/g, " ").trim(),
        });
      }
    }

    return res.json({
      bookName: resolved.normalizedName,
      query,
      totalMatches: matches.length,
      matches: sortNaturally(matches.map((item) => item.page)).map((page) =>
        matches.find((item) => item.page === page)
      ),
    });
  });

  app.get("/books/:bookName/ocr/:pageName/download", (req, res) => {
    const resolved = resolveBookPath(req.params.bookName);
    if (!resolved) {
      return res.status(400).json({ message: "잘못된 책 이름입니다." });
    }
    if (!fs.existsSync(resolved.resolved)) {
      return res.status(404).json({ message: "책 없음" });
    }

    const pageName = path.basename(String(req.params.pageName || "")).trim();
    const allPages = getImagePages(resolved.resolved);
    if (!allPages.includes(pageName)) {
      return res.status(404).json({ message: "페이지 없음" });
    }

    const txtPath = getOcrTextPath(resolved.resolved, pageName);
    if (!fs.existsSync(txtPath)) {
      return res.status(404).json({ message: "해당 페이지 OCR 결과가 없습니다." });
    }

    return res.download(txtPath, `${path.parse(pageName).name}.txt`);
  });

  app.get("/books/:bookName/ocr/download-all", (req, res) => {
    const resolved = resolveBookPath(req.params.bookName);
    if (!resolved) {
      return res.status(400).json({ message: "잘못된 책 이름입니다." });
    }
    if (!fs.existsSync(resolved.resolved)) {
      return res.status(404).json({ message: "책 없음" });
    }

    const pages = getImagePages(resolved.resolved);
    if (!pages.length) {
      return res.status(400).json({ message: "페이지가 없습니다." });
    }

    const missing = pages.filter((page) => !fs.existsSync(getOcrTextPath(resolved.resolved, page)));
    if (missing.length > 0) {
      return res.status(400).json({
        message: "아직 OCR이 완료되지 않은 페이지가 있습니다.",
        missingPages: missing,
      });
    }

    const combined = pages
      .map((page) => {
        const text = fs.readFileSync(getOcrTextPath(resolved.resolved, page), "utf8");
        return `===== ${page} =====\n${text}`.trimEnd();
      })
      .join("\n\n");

    const fileName = `${resolved.normalizedName}_ocr_all.txt`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    return res.send(combined);
  });

  if (serveFrontend && fs.existsSync(frontendBuildPath)) {
    app.use(express.static(frontendBuildPath));

    app.get("*", (req, res, next) => {
      if (
        req.path.startsWith("/upload") ||
        req.path.startsWith("/books") ||
        req.path.startsWith("/process") ||
        req.path.startsWith("/uploads")
      ) {
        return next();
      }

      return res.sendFile(path.join(frontendBuildPath, "index.html"));
    });
  }

  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ message: `업로드 오류: ${err.message}` });
    }

    if (err) {
      return res.status(500).json({ message: "서버 오류가 발생했습니다." });
    }

    return next();
  });

  return app;
};

const startServer = () => {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const uploadRoot = process.env.UPLOAD_ROOT || DEFAULT_UPLOAD_ROOT;
  const frontendBuildPath = DEFAULT_FRONTEND_BUILD_PATH;
  const app = createApp({ uploadRoot, frontendBuildPath, serveFrontend: true, startedAt: new Date() });
  const server = app.listen(port, () => {
    console.log(`Server running at http://localhost:${port} (pid=${process.pid})`);
    console.log(`Health check: http://localhost:${port}/health`);
    if (fs.existsSync(frontendBuildPath)) {
      console.log("Frontend build detected and served by backend.");
    } else {
      console.log("Frontend build not found. Run: cd ../frontend && npm run build");
    }
  });

  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Stop the existing process or run with PORT=<other-port>.`);
      console.error(`Check owner: lsof -i :${port} -n -P`);
      process.exit(1);
    }
    if (error?.code === "EACCES") {
      console.error(`Permission denied for port ${port}. Try a higher port (for example 5001).`);
      process.exit(1);
    }

    console.error("Failed to start server:", error);
    process.exit(1);
  });

  return server;
};

if (require.main === module) {
  startServer();
}

module.exports = { createApp, startServer };
