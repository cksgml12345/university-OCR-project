const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const request = require("supertest");
const { createApp } = require("./server");

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
  const res = await request(app).get("/books").expect(200);
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

  const res = await request(app).post("/process/BookA").send({}).expect(200);
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

  const res = await request(app).post("/process/BookA").send({ includeProcessed: true }).expect(200);
  assert.equal(res.body.processedPages, 3);
  assert.equal(res.body.skippedPages.length, 0);
  assert.equal(callCount, 3);
});

test("PUT /books/:bookName/ocr/:pageName saves edited OCR text", async (t) => {
  const uploadRoot = makeTempDir();
  t.after(() => fs.rmSync(uploadRoot, { recursive: true, force: true }));
  setupSampleBook(uploadRoot);
  const app = createApp({ uploadRoot, serveFrontend: false, ocrExtractor: async () => "dummy" });

  await request(app)
    .put("/books/BookA/ocr/2.jpg")
    .send({ text: "edited line 1\nedited line 2" })
    .expect(200);

  const getRes = await request(app).get("/books/BookA/ocr/2.jpg").expect(200);
  assert.equal(getRes.body.text, "edited line 1\nedited line 2");
});

test("GET /books/:bookName/search returns OCR text matches", async (t) => {
  const uploadRoot = makeTempDir();
  t.after(() => fs.rmSync(uploadRoot, { recursive: true, force: true }));
  setupSampleBook(uploadRoot);
  writeFile(path.join(uploadRoot, "BookA", "ocr", "1.txt"), "alpha beta beta");
  writeFile(path.join(uploadRoot, "BookA", "ocr", "10.txt"), "gamma");

  const app = createApp({ uploadRoot, serveFrontend: false, ocrExtractor: async () => "dummy" });
  const res = await request(app).get("/books/BookA/search?q=beta").expect(200);
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
  const res = await request(app).get("/process-stream/BookA").expect(200);
  assert.match(res.text, /event: complete/);
  assert.match(res.text, /"processedPages":0/);
});
