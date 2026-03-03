import React, { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import "./App.css";

const API_BASE_URL = process.env.REACT_APP_API_URL || "";

function App() {
  const [books, setBooks] = useState([]);
  const [selectedBook, setSelectedBook] = useState("");
  const [pages, setPages] = useState([]);
  const [selectedPage, setSelectedPage] = useState("");
  const [checkedPages, setCheckedPages] = useState([]);
  const [processedPages, setProcessedPages] = useState([]);
  const [ocrPages, setOcrPages] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [status, setStatus] = useState("준비 완료");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [processProgress, setProcessProgress] = useState(0);
  const [processTotal, setProcessTotal] = useState(0);
  const [processDone, setProcessDone] = useState(0);
  const [processPhase, setProcessPhase] = useState("idle");
  const directoryInputRef = useRef(null);

  useEffect(() => {
    fetchBooks();
  }, []);

  useEffect(() => {
    if (directoryInputRef.current) {
      directoryInputRef.current.setAttribute("webkitdirectory", "");
      directoryInputRef.current.setAttribute("directory", "");
    }
  }, []);

  const fetchBooks = async () => {
    try {
      setError("");
      const res = await axios.get(`${API_BASE_URL}/books`);
      setBooks(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      setError("책 목록을 불러오지 못했습니다. 서버 상태를 확인해 주세요.");
    }
  };

  const fetchPages = async (book) => {
    try {
      setError("");
      setStatus(`"${book}" 페이지를 불러오는 중...`);
      const res = await axios.get(
        `${API_BASE_URL}/books/${encodeURIComponent(book)}`
      );
      const newPages = Array.isArray(res.data.pages) ? res.data.pages : [];
      const newProcessedPages = Array.isArray(res.data.processedPages)
        ? res.data.processedPages
        : [];
      const newOcrPages = Array.isArray(res.data.ocrPages) ? res.data.ocrPages : [];
      setSelectedBook(book);
      setPages(newPages);
      setSelectedPage(newPages[0] || "");
      setCheckedPages([]);
      setProcessedPages(newProcessedPages);
      setOcrPages(newOcrPages);
      setStatus(`"${book}" 로드 완료 (${newPages.length}페이지)`);
    } catch (err) {
      setError("페이지 목록을 불러오지 못했습니다.");
      setPages([]);
      setSelectedPage("");
      setCheckedPages([]);
      setProcessedPages([]);
      setOcrPages([]);
    }
  };

  const handleUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) {
      return;
    }

    const formData = new FormData();
    for (const file of files) {
      const relativePath = file.webkitRelativePath || file.name;
      formData.append("files", file, relativePath);
    }

    try {
      setError("");
      setIsBusy(true);
      setUploadProgress(0);
      setStatus(`업로드 중... (${files.length}개 파일)`);

      const res = await axios.post(`${API_BASE_URL}/upload`, formData, {
        onUploadProgress: (progressEvent) => {
          if (!progressEvent.total) {
            return;
          }
          const percent = Math.round(
            (progressEvent.loaded * 100) / progressEvent.total
          );
          setUploadProgress(percent);
        },
      });

      await fetchBooks();
      const uploadedBooks = Array.isArray(res.data?.books) ? res.data.books : [];
      if (uploadedBooks.length > 0) {
        await fetchPages(uploadedBooks[0]);
      }
      setStatus(
        `업로드 완료 (${uploadedBooks.length || 0}권 / ${
          res.data?.uploadedFiles || files.length
        }개 파일)`
      );
    } catch (err) {
      setError("업로드에 실패했습니다. 폴더 선택과 서버 연결을 확인해 주세요.");
    } finally {
      setIsBusy(false);
      setUploadProgress(0);
      e.target.value = "";
    }
  };

  const runProcess = async (mode) => {
    if (!selectedBook) {
      setError("먼저 책을 선택해 주세요.");
      return;
    }

    if (mode === "selected" && checkedPages.length === 0) {
      setError("선택 공정을 실행하려면 최소 1개 면을 체크해 주세요.");
      return;
    }

    try {
      setError("");
      setIsBusy(true);

      const targetPages = mode === "selected" ? [...checkedPages] : [...pages];
      const targetCount = targetPages.length;
      setProcessTotal(targetCount);
      setProcessDone(0);
      setProcessProgress(0);
      setProcessPhase("running");
      setStatus(
        `"${selectedBook}" ${mode === "selected" ? "선택 면" : "책 전체"} 공정 실행 중... (${targetCount}개)`
      );

      await new Promise((resolve, reject) => {
        const query =
          mode === "selected"
            ? `?pages=${encodeURIComponent(targetPages.join(","))}`
            : "";
        const streamUrl = `${API_BASE_URL}/process-stream/${encodeURIComponent(
          selectedBook
        )}${query}`;
        const eventSource = new EventSource(streamUrl);
        let settled = false;
        const safeResolve = () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve();
        };
        const safeReject = (error) => {
          if (settled) {
            return;
          }
          settled = true;
          reject(error);
        };

        eventSource.addEventListener("progress", (event) => {
          const payload = JSON.parse(event.data || "{}");
          const done = Number(payload.done || 0);
          const total = Number(payload.total || targetCount);
          const percent = Number(payload.percent || 0);
          setProcessDone(done);
          setProcessTotal(total);
          setProcessProgress(percent);
          setStatus(`"${selectedBook}" 공정 실행 중... (${done}/${total})`);
        });

        eventSource.addEventListener("complete", (event) => {
          const payload = JSON.parse(event.data || "{}");
          const resultPages = Array.isArray(payload.pages) ? payload.pages : targetPages;
          setProcessedPages((prev) => [...new Set([...prev, ...resultPages])]);
          setOcrPages((prev) => [...new Set([...prev, ...resultPages])]);
          setProcessDone(resultPages.length);
          setProcessTotal(resultPages.length || targetCount);
          setProcessProgress(100);
          setProcessPhase("completed");
          setStatus(`OCR 공정 완료: ${resultPages.length}페이지 처리 완료`);
          eventSource.close();
          safeResolve();
        });

        eventSource.addEventListener("error", (event) => {
          try {
            const payload = JSON.parse(event.data || "{}");
            safeReject(new Error(payload.message || "공정 실행 중 오류가 발생했습니다."));
          } catch (_ignored) {
            safeReject(new Error("공정 실행 중 오류가 발생했습니다."));
          } finally {
            eventSource.close();
          }
        });

        eventSource.onerror = () => {
          eventSource.close();
          safeReject(new Error("공정 스트림 연결이 종료되었습니다."));
        };
      });
    } catch (err) {
      setProcessPhase("idle");
      setError(err.message || "공정 실행 중 오류가 발생했습니다.");
    } finally {
      setIsBusy(false);
    }
  };

  const deleteBook = async (bookName) => {
    const ok = window.confirm(`"${bookName}" 책을 삭제할까요?`);
    if (!ok) {
      return;
    }

    try {
      setError("");
      setIsBusy(true);
      setStatus(`"${bookName}" 삭제 중...`);
      await axios.delete(`${API_BASE_URL}/books/${encodeURIComponent(bookName)}`);
      await fetchBooks();

      if (selectedBook === bookName) {
        setSelectedBook("");
        setPages([]);
        setSelectedPage("");
        setCheckedPages([]);
        setProcessedPages([]);
        setOcrPages([]);
      }

      setStatus(`"${bookName}" 삭제 완료`);
    } catch (err) {
      setError("책 삭제에 실패했습니다.");
    } finally {
      setIsBusy(false);
    }
  };

  const togglePageCheck = (page) => {
    setCheckedPages((prev) =>
      prev.includes(page) ? prev.filter((item) => item !== page) : [...prev, page]
    );
  };

  const allChecked = pages.length > 0 && checkedPages.length === pages.length;

  const toggleAllChecks = () => {
    if (allChecked) {
      setCheckedPages([]);
      return;
    }
    setCheckedPages([...pages]);
  };

  const filteredBooks = useMemo(() => {
    return books.filter((book) =>
      book.name.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [books, searchTerm]);

  const selectedBookMeta = books.find((book) => book.name === selectedBook);
  const allOcrReady = pages.length > 0 && ocrPages.length === pages.length;

  const extractFilename = (contentDisposition, fallbackName) => {
    if (!contentDisposition) {
      return fallbackName;
    }
    const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
      try {
        return decodeURIComponent(utf8Match[1]);
      } catch (_error) {
        return fallbackName;
      }
    }
    const asciiMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
    return asciiMatch?.[1] || fallbackName;
  };

  const triggerDownload = async (href, fallbackName) => {
    const response = await axios.get(href, { responseType: "blob" });
    const disposition = response.headers?.["content-disposition"];
    const filename = extractFilename(disposition, fallbackName);
    const url = window.URL.createObjectURL(response.data);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  const downloadPageOcr = async (page) => {
    if (!selectedBook) {
      return;
    }
    const href = `${API_BASE_URL}/books/${encodeURIComponent(
      selectedBook
    )}/ocr/${encodeURIComponent(page)}/download`;
    try {
      await triggerDownload(href, `${page.replace(/\.[^.]+$/, "")}.txt`);
    } catch (_error) {
      setError("파일 다운로드에 실패했습니다.");
    }
  };

  const downloadAllOcr = async () => {
    if (!selectedBook) {
      return;
    }
    const href = `${API_BASE_URL}/books/${encodeURIComponent(
      selectedBook
    )}/ocr/download-all`;
    try {
      await triggerDownload(href, `${selectedBook}_ocr_all.txt`);
    } catch (_error) {
      setError("합본 다운로드에 실패했습니다.");
    }
  };

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Semester Project</p>
          <h1>Book Processing Console</h1>
          <p className="subtitle">
            업로드부터 페이지 검수, 공정 실행까지 한 번에 관리
          </p>
        </div>
        <div className="summary-cards">
          <div className="summary-card">
            <span>Books</span>
            <strong>{books.length}</strong>
          </div>
          <div className="summary-card">
            <span>Pages</span>
            <strong>
              {books.reduce((total, book) => total + (book.pageCount || 0), 0)}
            </strong>
          </div>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <main className="workspace">
        <aside className="panel library-panel">
          <div className="panel-head">
            <h2>Library</h2>
            <button type="button" className="ghost-btn" onClick={fetchBooks} disabled={isBusy}>
              새로고침
            </button>
          </div>

          <label className="upload-btn">
            폴더 업로드
            <input
              ref={directoryInputRef}
              type="file"
              multiple
              webkitdirectory=""
              directory=""
              hidden
              disabled={isBusy}
              onChange={handleUpload}
            />
          </label>

          {uploadProgress > 0 && (
            <div className="progress-wrap">
              <div
                className="progress-bar"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          )}

          <input
            className="search-input"
            placeholder="책 이름 검색"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />

          <div className="book-list">
            {filteredBooks.length === 0 && (
              <div className="empty">조건에 맞는 책이 없습니다.</div>
            )}
            {filteredBooks.map((book) => (
              <div
                key={book.name}
                className={`book-item-row ${selectedBook === book.name ? "active" : ""}`}
              >
                <button
                  type="button"
                  className="book-item"
                  onClick={() => fetchPages(book.name)}
                  disabled={isBusy}
                >
                  <strong>{book.name}</strong>
                  <span>{book.pageCount || 0} pages</span>
                </button>
                <button
                  type="button"
                  className="book-delete-btn"
                  onClick={() => deleteBook(book.name)}
                  disabled={isBusy}
                >
                  삭제
                </button>
              </div>
            ))}
          </div>

          <div className="status-box">
            <span>Status</span>
            <p>{isBusy ? "작업 진행 중..." : status}</p>
          </div>
        </aside>

        <section className="panel viewer-panel">
          {!selectedBook && (
            <div className="empty viewer-empty">
              책을 선택하면 페이지 미리보기가 표시됩니다.
            </div>
          )}

          {selectedBook && (
            <>
              <div className="panel-head viewer-head">
                <div>
                  <h2>{selectedBook}</h2>
                  <p>
                    {selectedBookMeta?.pageCount || pages.length}페이지 등록됨
                  </p>
                </div>
                <div className="process-actions">
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={downloadAllOcr}
                    disabled={isBusy || !allOcrReady}
                  >
                    OCR 합본 다운로드
                  </button>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => runProcess("selected")}
                    disabled={isBusy || checkedPages.length === 0}
                  >
                    선택 면 공정
                  </button>
                  <button
                    type="button"
                    className="process-btn"
                    onClick={() => runProcess("book")}
                    disabled={isBusy || pages.length === 0}
                  >
                    책 전체 공정
                  </button>
                </div>
              </div>

              <div className="page-toolbar">
                <label>
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleAllChecks}
                    disabled={isBusy || pages.length === 0}
                  />
                  전체 선택
                </label>
                <span>{checkedPages.length}개 선택됨</span>
              </div>

              {(processPhase === "running" || processPhase === "completed") &&
                processTotal > 0 && (
                <div className="process-progress-panel">
                  <div className="process-progress-head">
                    <span>공정 진행률</span>
                    <strong>
                      {processDone}/{processTotal}
                    </strong>
                  </div>
                  <div className="progress-wrap process-progress-wrap">
                    <div
                      className="progress-bar process-progress-bar"
                      style={{ width: `${processProgress}%` }}
                    />
                  </div>
                  {processPhase === "completed" && (
                    <button type="button" className="process-complete-btn">
                      공정 완료되었습니다
                    </button>
                  )}
                </div>
              )}

              {selectedPage ? (
                <div className="preview-card">
                  <img
                    src={`${API_BASE_URL}/uploads/${encodeURIComponent(
                      selectedBook
                    )}/${encodeURIComponent(selectedPage)}`}
                    alt={selectedPage}
                  />
                  <div className="preview-caption">{selectedPage}</div>
                </div>
              ) : (
                <div className="empty">표시할 이미지 페이지가 없습니다.</div>
              )}

              <div className="thumb-grid">
                {pages.map((page) => (
                  <div
                    key={page}
                    className={`thumb ${selectedPage === page ? "active" : ""}`}
                    onClick={() => setSelectedPage(page)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedPage(page);
                      }
                    }}
                  >
                    <img
                      src={`${API_BASE_URL}/uploads/${encodeURIComponent(
                        selectedBook
                      )}/${encodeURIComponent(page)}`}
                      alt={page}
                    />
                    <span
                      className={
                        processedPages.includes(page) ? "thumb-name processed" : "thumb-name"
                      }
                    >
                      {page}
                    </span>
                    <label
                      className="thumb-check"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={checkedPages.includes(page)}
                        onChange={() => togglePageCheck(page)}
                        disabled={isBusy}
                      />
                      선택
                    </label>
                    <button
                      type="button"
                      className="thumb-download-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        downloadPageOcr(page);
                      }}
                      disabled={isBusy || !ocrPages.includes(page)}
                    >
                      txt 다운로드
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
