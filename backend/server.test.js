const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { PassThrough } = require("node:stream");
const { createApp } = require("./server");

const parseJsonSafe = (text) => {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
};

const sendRequest = (app, method, url, body) =>
  new Promise((resolve, reject) => {
    const socket = new PassThrough();
    socket.setTimeout = () => {};
    socket.setNoDelay = () => {};
    socket.setKeepAlive = () => {};
    socket.destroy = () => {};
    socket.destroyed = false;
    socket.remoteAddress = "127.0.0.1";
    socket.remotePort = 0;
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = url;
    req.headers = {};

    if (body !== undefined) {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      req.headers["content-type"] = "application/json";
      req.headers["content-length"] = Buffer.byteLength(payload);
      req.push(payload);
    }
    req.push(null);

    const res = new http.ServerResponse(req);
    res.assignSocket(socket);

    const chunks = [];
    const originalWrite = res.write.bind(res);
    res.write = (chunk, ...args) => {
      if (chunk) {
        chunks.push(Buffer.from(chunk));
      }
      return originalWrite(chunk, ...args);
    };

    const originalEnd = res.end.bind(res);
    res.end = (chunk, ...args) => {
      if (chunk) {
        chunks.push(Buffer.from(chunk));
      }
      return originalEnd(chunk, ...args);
    };

    let settled = false;
    const finalize = () => {
      if (settled) {
        return;
      }
      settled = true;
      const text = Buffer.concat(chunks).toString("utf8");
      const bodyJson = parseJsonSafe(text);
      resolve({ status: res.statusCode, text, body: bodyJson, headers: res.getHeaders() });
    };

    res.on("finish", finalize);
    res.on("close", finalize);

    res.on("error", reject);

    try {
      app.handle(req, res);
    } catch (error) {
      reject(error);
    }

    setTimeout(() => {
      if (!settled) {
        reject(new Error(`Request timed out: ${method} ${url}`));
      }
    }, 1000);
  });

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "book-ocr-test-"));

const writeFile = (targetPath, content = "") => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
};

const setupSampleBook = (rootDir) => {
  writeFile(path.join(rootDir, "BookA", "1.jpg"), "img");
  writeFile(path.join(rootDir, "BookA", "2.jpg"), "img");
  writeFile(path.join(rootDir, "BookA", "10.jpg"), "img");
};

test("GET /books returns book list with page count", async (t) => {
  const uploadRoot = makeTempDir();
  t.after(() => fs.rmSync(uploadRoot, { recursive: true, force: true }));
  setupSampleBook(uploadRoot);

  const app = createApp({ uploadRoot, serveFrontend: false, ocrExtractor: async () => "dummy" });
  const res = await sendRequest(app, "GET", "/books");
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, "BookA");
  assert.equal(res.body[0].pageCount, 3);
});

test("POST /process skips pages with existing OCR by default", async (t) => {
  const uploadRoot = makeTempDir();
  t.after(() => fs.rmSync(uploadRoot, { recursive: true, force: true }));
  setupSampleBook(uploadRoot);
  writeFile(path.join(uploadRoot, "BookA", "ocr", "1.txt"), "already done");

  let callCount = 0;
  const app = createApp({
    uploadRoot,
    serveFrontend: false,
    ocrExtractor: async (imagePath) => {
      callCount += 1;
      return `ocr:${path.basename(imagePath)}`;
    },
  });

  const res = await sendRequest(app, "POST", "/process/BookA", {});
  assert.equal(res.status, 200);
  assert.equal(res.body.processedPages, 2);
  assert.deepEqual(res.body.skippedPages, ["1.jpg"]);
  assert.equal(callCount, 2);
  assert.equal(fs.existsSync(path.join(uploadRoot, "BookA", "ocr", "2.txt")), true);
  assert.equal(fs.existsSync(path.join(uploadRoot, "BookA", "ocr", "10.txt")), true);
});

test("POST /process can include processed pages", async (t) => {
  const uploadRoot = makeTempDir();
  t.after(() => fs.rmSync(uploadRoot, { recursive: true, force: true }));
  setupSampleBook(uploadRoot);
  writeFile(path.join(uploadRoot, "BookA", "ocr", "1.txt"), "already done");

  let callCount = 0;
  const app = createApp({
    uploadRoot,
    serveFrontend: false,
    ocrExtractor: async () => {
      callCount += 1;
      return "ocr";
    },
  });

  const res = await sendRequest(app, "POST", "/process/BookA", { includeProcessed: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.processedPages, 3);
  assert.equal(res.body.skippedPages.length, 0);
  assert.equal(callCount, 3);
});

test("PUT /books/:bookName/ocr/:pageName saves edited OCR text", async (t) => {
  const uploadRoot = makeTempDir();
  t.after(() => fs.rmSync(uploadRoot, { recursive: true, force: true }));
  setupSampleBook(uploadRoot);
  const app = createApp({ uploadRoot, serveFrontend: false, ocrExtractor: async () => "dummy" });

  const putRes = await sendRequest(app, "PUT", "/books/BookA/ocr/2.jpg", {
    text: "edited line 1\nedited line 2",
  });
  assert.equal(putRes.status, 200);

  const getRes = await sendRequest(app, "GET", "/books/BookA/ocr/2.jpg");
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.text, "edited line 1\nedited line 2");
});

test("GET /books/:bookName/search returns OCR text matches", async (t) => {
  const uploadRoot = makeTempDir();
  t.after(() => fs.rmSync(uploadRoot, { recursive: true, force: true }));
  setupSampleBook(uploadRoot);
  writeFile(path.join(uploadRoot, "BookA", "ocr", "1.txt"), "alpha beta beta");
  writeFile(path.join(uploadRoot, "BookA", "ocr", "10.txt"), "gamma");

  const app = createApp({ uploadRoot, serveFrontend: false, ocrExtractor: async () => "dummy" });
  const res = await sendRequest(app, "GET", "/books/BookA/search?q=beta");
  assert.equal(res.status, 200);
  assert.equal(res.body.totalMatches, 1);
  assert.equal(res.body.matches[0].page, "1.jpg");
  assert.equal(res.body.matches[0].occurrences, 2);
});

test("GET /process-stream emits complete even when all pages are skipped", async (t) => {
  const uploadRoot = makeTempDir();
  t.after(() => fs.rmSync(uploadRoot, { recursive: true, force: true }));
  setupSampleBook(uploadRoot);
  writeFile(path.join(uploadRoot, "BookA", "ocr", "1.txt"), "done");
  writeFile(path.join(uploadRoot, "BookA", "ocr", "2.txt"), "done");
  writeFile(path.join(uploadRoot, "BookA", "ocr", "10.txt"), "done");

  const app = createApp({ uploadRoot, serveFrontend: false, ocrExtractor: async () => "dummy" });
  const res = await sendRequest(app, "GET", "/process-stream/BookA");
  assert.equal(res.status, 200);
  assert.match(res.text, /event: complete/);
  assert.match(res.text, /"processedPages":0/);
});
