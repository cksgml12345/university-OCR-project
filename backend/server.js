const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const DEFAULT_PORT = 5001;
const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const UPLOAD_ROOT = path.join(__dirname, "uploads");
const FRONTEND_BUILD_PATH = path.resolve(__dirname, "../frontend/build");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
const OCR_LANG = process.env.OCR_LANG || "eng";
let tesseractModulePromise = null;
const STARTED_AT = new Date();

app.use(cors());
app.use(express.json());

// uploads 폴더 정적 접근 허용
app.use("/uploads", express.static(UPLOAD_ROOT));

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const sortNaturally = (list) =>
  [...list].sort((a, b) =>
    a.localeCompare(b, "ko", { numeric: true, sensitivity: "base" })
  );

const resolveBookPath = (bookName) => {
  let decoded = "";
  try {
    decoded = decodeURIComponent(bookName || "");
  } catch (error) {
    return null;
  }
  const normalizedName = path.basename(decoded).trim();
  const resolved = path.resolve(UPLOAD_ROOT, normalizedName);

  if (!normalizedName || !resolved.startsWith(UPLOAD_ROOT + path.sep)) {
    return null;
  }

  return { normalizedName, resolved };
};

const isImageFile = (fileName) =>
  IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());

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

const getTesseract = async () => {
  if (!tesseractModulePromise) {
    tesseractModulePromise = Promise.resolve().then(() => require("tesseract.js"));
  }
  return tesseractModulePromise;
};

const extractTextFromImageLocal = async (imagePath) => {
  const Tesseract = await getTesseract();
  const result = await Tesseract.recognize(imagePath, OCR_LANG);
  return String(result?.data?.text || "").trim();
};

// 업로드 저장 방식 설정
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // 폴더 업로드 시 originalname: "BookName/file.jpg" 형태
    const relativePath = file.originalname.replace(/\\/g, "/");
    const segments = relativePath.split("/").filter(Boolean);
    const firstSegment = segments[0] || "";
    const fromPath = segments.length > 1 ? firstSegment : "";
    const requestedBookName = path.basename(String(req.body?.bookName || "")).trim();
    const bookName = path.basename(fromPath || requestedBookName || "untitled").trim();
    const uploadPath = path.join(UPLOAD_ROOT, bookName || "untitled");

    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    cb(null, path.basename(file.originalname.replace(/\\/g, "/")));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 5000 },
});

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

// 폴더 업로드
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

// 책 목록 조회
app.get("/books", (req, res) => {
  if (!fs.existsSync(UPLOAD_ROOT)) {
    return res.json([]);
  }

  const bookDirectories = fs
    .readdirSync(UPLOAD_ROOT)
    .filter((entry) => fs.statSync(path.join(UPLOAD_ROOT, entry)).isDirectory());

  const books = sortNaturally(bookDirectories).map((bookName) => {
    const bookPath = path.join(UPLOAD_ROOT, bookName);
    const pageCount = getImagePages(bookPath).length;
    const updatedAt = fs.statSync(bookPath).mtime;
    return { name: bookName, pageCount, updatedAt };
  });

  res.json(books);
});

app.get("/health", (req, res) => {
  return res.json({
    ok: true,
    pid: process.pid,
    port: PORT,
    uptimeSec: Math.floor(process.uptime()),
    startedAt: STARTED_AT.toISOString(),
    now: new Date().toISOString(),
  });
});

// 특정 책 페이지 조회
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
  res.json({
    bookName: normalizedName,
    pageCount: pages.length,
    pages,
    processedPages,
    ocrPages,
    allOcrReady: pages.length > 0 && ocrPages.length === pages.length,
  });
});

// 책 삭제
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

// 공정 실행 (OCR)
app.post("/process/:bookName", async (req, res) => {
  const resolved = resolveBookPath(req.params.bookName);

  if (!resolved) {
    return res.status(400).json({ message: "잘못된 책 이름입니다." });
  }

  if (!fs.existsSync(resolved.resolved)) {
    return res.status(404).json({ message: "책 없음" });
  }

  const allPages = getImagePages(resolved.resolved);
  const requestPages = Array.isArray(req.body?.pages)
    ? req.body.pages.map((page) => String(page))
    : null;
  const targetPages = resolveTargetPages(allPages, requestPages);

  if (!targetPages.length) {
    return res.status(400).json({ message: "처리할 페이지가 없습니다." });
  }

  const ocrRoot = path.join(resolved.resolved, "ocr");
  fs.mkdirSync(ocrRoot, { recursive: true });

  try {
    const ocrResults = [];
    for (const pageName of targetPages) {
      const imagePath = path.join(resolved.resolved, pageName);
      const text = await extractTextFromImageLocal(imagePath);
      const txtPath = path.join(ocrRoot, `${path.parse(pageName).name}.txt`);
      fs.writeFileSync(txtPath, text, "utf8");
      ocrResults.push({
        page: pageName,
        textFile: path.basename(txtPath),
        charCount: text.length,
      });
    }

    const processedBefore = readProcessedPages(resolved.resolved, allPages);
    const processedAfter = sortNaturally([...new Set([...processedBefore, ...targetPages])]);
    writeProcessedPages(resolved.resolved, processedAfter);

    return res.json({
      message: "OCR 공정 완료",
      mode: requestPages ? "selected-pages" : "whole-book",
      bookName: resolved.normalizedName,
      processedPages: targetPages.length,
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
  const requestPages = rawPages
    ? String(rawPages)
        .split(",")
        .map((page) => page.trim())
        .filter(Boolean)
    : null;
  const targetPages = resolveTargetPages(allPages, requestPages);

  if (!targetPages.length) {
    return res.status(400).json({ message: "처리할 페이지가 없습니다." });
  }

  const ocrRoot = path.join(resolved.resolved, "ocr");
  fs.mkdirSync(ocrRoot, { recursive: true });

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
  });

  try {
    for (let index = 0; index < targetPages.length; index += 1) {
      if (closed) {
        return;
      }
      const pageName = targetPages[index];
      const imagePath = path.join(resolved.resolved, pageName);
      const text = await extractTextFromImageLocal(imagePath);
      const txtPath = path.join(ocrRoot, `${path.parse(pageName).name}.txt`);
      fs.writeFileSync(txtPath, text, "utf8");

      sendEvent("progress", {
        page: pageName,
        done: index + 1,
        total: targetPages.length,
        percent: Math.round(((index + 1) * 100) / targetPages.length),
      });
    }

    const processedBefore = readProcessedPages(resolved.resolved, allPages);
    const processedAfter = sortNaturally([...new Set([...processedBefore, ...targetPages])]);
    writeProcessedPages(resolved.resolved, processedAfter);

    sendEvent("complete", {
      message: "OCR 공정 완료",
      mode: requestPages ? "selected-pages" : "whole-book",
      bookName: resolved.normalizedName,
      processedPages: targetPages.length,
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

if (fs.existsSync(FRONTEND_BUILD_PATH)) {
  app.use(express.static(FRONTEND_BUILD_PATH));

  app.get("*", (req, res, next) => {
    if (
      req.path.startsWith("/upload") ||
      req.path.startsWith("/books") ||
      req.path.startsWith("/process") ||
      req.path.startsWith("/uploads")
    ) {
      return next();
    }

    return res.sendFile(path.join(FRONTEND_BUILD_PATH, "index.html"));
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

const server = app.listen(PORT, () => {
  console.log(`🔥 Server running at http://localhost:${PORT} (pid=${process.pid})`);
  console.log(`🩺 Health check: http://localhost:${PORT}/health`);
  if (fs.existsSync(FRONTEND_BUILD_PATH)) {
    console.log("📦 Frontend build detected and served by backend.");
  } else {
    console.log("ℹ️ Frontend build not found. Run: cd ../frontend && npm run build");
  }
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `❌ Port ${PORT} is already in use. Stop the existing process or run with PORT=<other-port>.`
    );
    console.error(`🔎 Check owner: lsof -i :${PORT} -n -P`);
    process.exit(1);
  }

  if (error?.code === "EACCES") {
    console.error(`❌ Permission denied for port ${PORT}. Try a higher port (for example 5001).`);
    process.exit(1);
  }

  console.error("❌ Failed to start server:", error);
  process.exit(1);
});
