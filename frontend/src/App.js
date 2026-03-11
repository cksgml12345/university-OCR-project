import React, { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import "./App.css";

const API_BASE_URL = process.env.REACT_APP_API_URL || "";
const THUMB_MIN_WIDTH = 130;
const THUMB_GAP = 10;
const THUMB_HEIGHT = 214;
const THUMB_OVERSCAN_ROWS = 2;

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
  const [skipProcessedPages, setSkipProcessedPages] = useState(true);
  const [ocrLang, setOcrLang] = useState("eng");
  const [ocrPsm, setOcrPsm] = useState("6");
  const [postprocessRules, setPostprocessRules] = useState({
    fixHyphenBreaks: true,
    preserveParagraphs: true,
    joinLines: true,
    collapseWhitespace: true,
  });
  const [ocrMeta, setOcrMeta] = useState({});
  const [lowConfidencePages, setLowConfidencePages] = useState([]);
  const [confidenceThreshold, setConfidenceThreshold] = useState(80);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [ocrEditorText, setOcrEditorText] = useState("");
  const [isLoadingOcrEditor, setIsLoadingOcrEditor] = useState(false);
  const [isSavingOcrEditor, setIsSavingOcrEditor] = useState(false);
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") {
      return "light";
    }
    const savedTheme = window.localStorage.getItem("book-ocr-theme");
    if (savedTheme === "light" || savedTheme === "dark") {
      return savedTheme;
    }
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });
  const [thumbViewport, setThumbViewport] = useState({ width: 0, height: 0, scrollTop: 0 });
  const directoryInputRef = useRef(null);
  const processControlRef = useRef(null);
  const thumbGridViewportRef = useRef(null);

  useEffect(() => {
    fetchBooks();
  }, []);

  useEffect(() => {
    if (directoryInputRef.current) {
      directoryInputRef.current.setAttribute("webkitdirectory", "");
      directoryInputRef.current.setAttribute("directory", "");
    }
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    document.documentElement.setAttribute("data-theme", theme);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("book-ocr-theme", theme);
    }
  }, [theme]);

  useEffect(() => {
    const viewport = thumbGridViewportRef.current;
    if (!viewport) {
      return undefined;
    }

    const updateViewport = () => {
      setThumbViewport({
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        scrollTop: viewport.scrollTop,
      });
    };

    updateViewport();
    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const resizeObserver = new ResizeObserver(updateViewport);
    resizeObserver.observe(viewport);

    return () => {
      resizeObserver.disconnect();
    };
  }, [selectedBook]);

  useEffect(() => {
    if (!thumbGridViewportRef.current) {
      return;
    }
    thumbGridViewportRef.current.scrollTop = 0;
    setThumbViewport((prev) => ({ ...prev, scrollTop: 0 }));
  }, [selectedBook, pages.length]);

  useEffect(() => {
    const loadSelectedPageOcr = async () => {
      if (!selectedBook || !selectedPage || !ocrPages.includes(selectedPage)) {
        setOcrEditorText("");
        return;
      }
      try {
        setIsLoadingOcrEditor(true);
        const res = await axios.get(
          `${API_BASE_URL}/books/${encodeURIComponent(selectedBook)}/ocr/${encodeURIComponent(selectedPage)}`
        );
        setOcrEditorText(typeof res.data?.text === "string" ? res.data.text : "");
      } catch (_error) {
        setOcrEditorText("");
      } finally {
        setIsLoadingOcrEditor(false);
      }
    };

    loadSelectedPageOcr();
  }, [selectedBook, selectedPage, ocrPages]);

  const fetchBooks = async () => {
    try {
      setError("");
      const res = await axios.get(`${API_BASE_URL}/books`);
      setBooks(Array.isArray(res.data) ? res.data : []);
    } catch (_err) {
      setError("책 목록을 불러오지 못했습니다. 서버 상태를 확인해 주세요.");
    }
  };

  const fetchPages = async (book) => {
    try {
      setError("");
      setStatus(`"${book}" 페이지를 불러오는 중...`);
      const res = await axios.get(`${API_BASE_URL}/books/${encodeURIComponent(book)}`);
      const newPages = Array.isArray(res.data.pages) ? res.data.pages : [];
      const newProcessedPages = Array.isArray(res.data.processedPages) ? res.data.processedPages : [];
      const newOcrPages = Array.isArray(res.data.ocrPages) ? res.data.ocrPages : [];
      const newOcrMeta = res.data?.ocrMeta && typeof res.data.ocrMeta === "object" ? res.data.ocrMeta : {};
      const newLowConfidence = Array.isArray(res.data?.lowConfidencePages) ? res.data.lowConfidencePages : [];
      const newConfidenceThreshold = Number(res.data?.confidenceThreshold) || 80;
      const newSettings = res.data?.ocrSettings && typeof res.data.ocrSettings === "object" ? res.data.ocrSettings : null;
      setSelectedBook(book);
      setPages(newPages);
      setSelectedPage(newPages[0] || "");
      setCheckedPages([]);
      setProcessedPages(newProcessedPages);
      setOcrPages(newOcrPages);
      setOcrMeta(newOcrMeta);
      setLowConfidencePages(newLowConfidence);
      setConfidenceThreshold(newConfidenceThreshold);
      if (newSettings) {
        if (newSettings.lang) {
          setOcrLang(newSettings.lang);
        }
        if (newSettings.psm) {
          setOcrPsm(String(newSettings.psm));
        }
        if (newSettings.postprocessRules && typeof newSettings.postprocessRules === "object") {
          setPostprocessRules((prev) => ({ ...prev, ...newSettings.postprocessRules }));
        }
      }
      setSearchResults([]);
      setSearchQuery("");
      setStatus(`"${book}" 로드 완료 (${newPages.length}페이지)`);
    } catch (_err) {
      setError("페이지 목록을 불러오지 못했습니다.");
      setPages([]);
      setSelectedPage("");
      setCheckedPages([]);
      setProcessedPages([]);
      setOcrPages([]);
      setOcrMeta({});
      setLowConfidencePages([]);
      setSearchResults([]);
      setSearchQuery("");
    }
  };

  const refreshBookMeta = async (book) => {
    if (!book) {
      return;
    }
    try {
      const res = await axios.get(`${API_BASE_URL}/books/${encodeURIComponent(book)}`);
      const nextPages = Array.isArray(res.data.pages) ? res.data.pages : [];
      const nextProcessedPages = Array.isArray(res.data.processedPages) ? res.data.processedPages : [];
      const nextOcrPages = Array.isArray(res.data.ocrPages) ? res.data.ocrPages : [];
      const nextOcrMeta = res.data?.ocrMeta && typeof res.data.ocrMeta === "object" ? res.data.ocrMeta : {};
      const nextLowConfidence = Array.isArray(res.data?.lowConfidencePages) ? res.data.lowConfidencePages : [];
      const nextConfidenceThreshold = Number(res.data?.confidenceThreshold) || 80;
      const nextSettings = res.data?.ocrSettings && typeof res.data.ocrSettings === "object" ? res.data.ocrSettings : null;
      setPages(nextPages);
      setProcessedPages(nextProcessedPages);
      setOcrPages(nextOcrPages);
      setOcrMeta(nextOcrMeta);
      setLowConfidencePages(nextLowConfidence);
      setConfidenceThreshold(nextConfidenceThreshold);
      if (nextSettings) {
        if (nextSettings.lang) {
          setOcrLang(nextSettings.lang);
        }
        if (nextSettings.psm) {
          setOcrPsm(String(nextSettings.psm));
        }
        if (nextSettings.postprocessRules && typeof nextSettings.postprocessRules === "object") {
          setPostprocessRules((prev) => ({ ...prev, ...nextSettings.postprocessRules }));
        }
      }
      if (selectedPage && !nextPages.includes(selectedPage)) {
        setSelectedPage(nextPages[0] || "");
      }
    } catch (_err) {
      setError("책 메타 정보를 갱신하지 못했습니다.");
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
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          setUploadProgress(percent);
        },
      });

      await fetchBooks();
      const uploadedBooks = Array.isArray(res.data?.books) ? res.data.books : [];
      if (uploadedBooks.length > 0) {
        await fetchPages(uploadedBooks[0]);
      }
      setStatus(
        `업로드 완료 (${uploadedBooks.length || 0}권 / ${res.data?.uploadedFiles || files.length}개 파일)`
      );
    } catch (_err) {
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

      const requestedPages = mode === "selected" ? [...checkedPages] : [...pages];
      const requestedCount = requestedPages.length;
      setProcessTotal(requestedCount);
      setProcessDone(0);
      setProcessProgress(0);
      setProcessPhase("running");
      setStatus(
        `"${selectedBook}" ${mode === "selected" ? "선택 면" : "책 전체"} 공정 실행 중... (${requestedCount}개)`
      );

      await new Promise((resolve, reject) => {
        const params = new URLSearchParams();
        if (mode === "selected") {
          params.set("pages", requestedPages.join(","));
        }
        params.set("includeProcessed", String(!skipProcessedPages));
        if (ocrLang) {
          params.set("lang", ocrLang);
        }
        if (ocrPsm) {
          params.set("psm", String(ocrPsm));
        }
        params.set("postprocessRules", JSON.stringify(postprocessRules));
        params.set("confidenceThreshold", String(confidenceThreshold));

        const streamUrl = `${API_BASE_URL}/process-stream/${encodeURIComponent(selectedBook)}?${
          params.toString() || ""
        }`;
        const eventSource = new EventSource(streamUrl);
        let settled = false;
        const safeResolve = () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve();
        };
        const safeReject = (processError) => {
          if (settled) {
            return;
          }
          settled = true;
          reject(processError);
        };
        processControlRef.current = { eventSource, reject: safeReject };

        eventSource.addEventListener("progress", (event) => {
          const payload = JSON.parse(event.data || "{}");
          const done = Number(payload.done || 0);
          const total = Number(payload.total || requestedCount);
          const percent = Number(payload.percent || 0);
          setProcessDone(done);
          setProcessTotal(total);
          setProcessProgress(percent);
          setStatus(`"${selectedBook}" 공정 실행 중... (${done}/${total})`);
        });

        eventSource.addEventListener("complete", (event) => {
          const payload = JSON.parse(event.data || "{}");
          const resultPages = Array.isArray(payload.pages) ? payload.pages : [];
          const skippedPages = Array.isArray(payload.skippedPages) ? payload.skippedPages : [];
          setProcessedPages((prev) => [...new Set([...prev, ...resultPages])]);
          setOcrPages((prev) => [...new Set([...prev, ...resultPages])]);
          if (payload?.ocrMeta && typeof payload.ocrMeta === "object") {
            setOcrMeta(payload.ocrMeta);
          }
          if (Array.isArray(payload?.lowConfidencePages)) {
            setLowConfidencePages(payload.lowConfidencePages);
          }
          setProcessDone(resultPages.length);
          setProcessTotal(resultPages.length);
          setProcessProgress(100);
          setProcessPhase("completed");
          if (resultPages.length === 0 && skippedPages.length > 0) {
            setStatus(`신규 처리 대상이 없어 완료됨 (기존 OCR ${skippedPages.length}개 스킵)`);
          } else {
            setStatus(`OCR 공정 완료: ${resultPages.length}페이지 처리 완료`);
          }
          eventSource.close();
          processControlRef.current = null;
          refreshBookMeta(selectedBook);
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
            processControlRef.current = null;
          }
        });

        eventSource.onerror = () => {
          eventSource.close();
          processControlRef.current = null;
          safeReject(new Error("공정 스트림 연결이 종료되었습니다."));
        };
      });
    } catch (err) {
      const message = err?.message || "공정 실행 중 오류가 발생했습니다.";
      if (message === "공정이 취소되었습니다.") {
        setProcessPhase("idle");
        setStatus("공정이 취소되었습니다.");
      } else {
        setProcessPhase("idle");
        setError(message);
      }
    } finally {
      setIsBusy(false);
      processControlRef.current = null;
    }
  };

  const cancelProcess = () => {
    if (!processControlRef.current) {
      return;
    }
    const { eventSource, reject } = processControlRef.current;
    eventSource.close();
    reject(new Error("공정이 취소되었습니다."));
    processControlRef.current = null;
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
        setSearchResults([]);
        setSearchQuery("");
      }

      setStatus(`"${bookName}" 삭제 완료`);
    } catch (_err) {
      setError("책 삭제에 실패했습니다.");
    } finally {
      setIsBusy(false);
    }
  };

  const runOcrSearch = async () => {
    if (!selectedBook) {
      setError("검색할 책을 먼저 선택해 주세요.");
      return;
    }
    const query = searchQuery.trim();
    if (!query) {
      setError("검색어를 입력해 주세요.");
      return;
    }

    try {
      setError("");
      setIsSearching(true);
      const res = await axios.get(
        `${API_BASE_URL}/books/${encodeURIComponent(selectedBook)}/search?q=${encodeURIComponent(query)}`
      );
      setSearchResults(Array.isArray(res.data?.matches) ? res.data.matches : []);
      setStatus(`"${query}" 검색 완료 (${res.data?.totalMatches || 0}개 페이지에서 발견)`);
    } catch (_err) {
      setSearchResults([]);
      setError("OCR 검색에 실패했습니다.");
    } finally {
      setIsSearching(false);
    }
  };

  const saveSelectedPageOcr = async () => {
    if (!selectedBook || !selectedPage) {
      return;
    }
    try {
      setError("");
      setIsSavingOcrEditor(true);
      const res = await axios.put(
        `${API_BASE_URL}/books/${encodeURIComponent(selectedBook)}/ocr/${encodeURIComponent(selectedPage)}`,
        { text: ocrEditorText }
      );
      const processed = Array.isArray(res.data?.processedPagesList) ? res.data.processedPagesList : [];
      setProcessedPages(processed);
      setOcrPages(processed);
      refreshBookMeta(selectedBook);
      setStatus(`"${selectedPage}" OCR 텍스트 저장 완료`);
    } catch (_err) {
      setError("OCR 텍스트 저장에 실패했습니다.");
    } finally {
      setIsSavingOcrEditor(false);
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

  const saveOcrSettings = async () => {
    if (!selectedBook) {
      setError("먼저 책을 선택해 주세요.");
      return;
    }
    try {
      setError("");
      setIsBusy(true);
      const payload = {
        confidenceThreshold,
        lang: ocrLang,
        psm: ocrPsm,
        postprocessRules,
      };
      const res = await axios.put(
        `${API_BASE_URL}/books/${encodeURIComponent(selectedBook)}/settings`,
        payload
      );
      if (res.data?.ocrSettings && typeof res.data.ocrSettings === "object") {
        const settings = res.data.ocrSettings;
        if (settings.lang) {
          setOcrLang(settings.lang);
        }
        if (settings.psm) {
          setOcrPsm(String(settings.psm));
        }
        if (settings.postprocessRules && typeof settings.postprocessRules === "object") {
          setPostprocessRules((prev) => ({ ...prev, ...settings.postprocessRules }));
        }
        if (typeof settings.confidenceThreshold === "number") {
          setConfidenceThreshold(settings.confidenceThreshold);
        }
      }
      setStatus("OCR 설정 저장 완료");
      refreshBookMeta(selectedBook);
    } catch (_err) {
      setError("OCR 설정 저장에 실패했습니다.");
    } finally {
      setIsBusy(false);
    }
  };

  const selectLowConfidence = () => {
    if (lowConfidencePages.length === 0) {
      return;
    }
    setCheckedPages(lowConfidencePages);
  };

  const filteredBooks = useMemo(() => {
    return books.filter((book) => book.name.toLowerCase().includes(searchTerm.toLowerCase()));
  }, [books, searchTerm]);

  const selectedBookMeta = books.find((book) => book.name === selectedBook);
  const allOcrReady = pages.length > 0 && ocrPages.length === pages.length;
  const totalPages = books.reduce((total, book) => total + (book.pageCount || 0), 0);
  const processedCount = processedPages.length;
  const ocrCompletionRate = pages.length > 0 ? Math.round((processedCount / pages.length) * 100) : 0;
  const selectedPageIndex = selectedPage ? pages.indexOf(selectedPage) : -1;
  const selectedPageMeta = selectedPage ? ocrMeta?.[selectedPage] : null;
  const thumbColumns = Math.max(
    1,
    Math.floor((thumbViewport.width + THUMB_GAP) / (THUMB_MIN_WIDTH + THUMB_GAP)) || 1
  );
  const thumbCellWidth =
    thumbViewport.width > 0
      ? Math.max(THUMB_MIN_WIDTH, Math.floor((thumbViewport.width - THUMB_GAP * (thumbColumns - 1)) / thumbColumns))
      : THUMB_MIN_WIDTH;
  const thumbRowHeight = THUMB_HEIGHT + THUMB_GAP;
  const thumbRowCount = Math.ceil(pages.length / thumbColumns);
  const thumbTotalHeight = thumbRowCount > 0 ? thumbRowCount * thumbRowHeight - THUMB_GAP : 0;
  const thumbStartRow = Math.max(0, Math.floor(thumbViewport.scrollTop / thumbRowHeight) - THUMB_OVERSCAN_ROWS);
  const thumbEndRow = Math.min(
    thumbRowCount - 1,
    Math.floor((thumbViewport.scrollTop + thumbViewport.height) / thumbRowHeight) + THUMB_OVERSCAN_ROWS
  );
  const visibleThumbs = useMemo(() => {
    if (pages.length === 0) {
      return [];
    }
    const startIndex = thumbStartRow * thumbColumns;
    const endIndex = Math.min(pages.length - 1, (thumbEndRow + 1) * thumbColumns - 1);
    const items = [];
    for (let index = startIndex; index <= endIndex; index += 1) {
      const row = Math.floor(index / thumbColumns);
      const col = index % thumbColumns;
      items.push({
        page: pages[index],
        top: row * thumbRowHeight,
        left: col * (thumbCellWidth + THUMB_GAP),
      });
    }
    return items;
  }, [pages, thumbColumns, thumbCellWidth, thumbStartRow, thumbEndRow, thumbRowHeight]);

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
    const href = `${API_BASE_URL}/books/${encodeURIComponent(selectedBook)}/ocr/${encodeURIComponent(page)}/download`;
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
    const href = `${API_BASE_URL}/books/${encodeURIComponent(selectedBook)}/ocr/download-all`;
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
          <p className="subtitle">업로드부터 페이지 검수, 공정 실행까지 한 번에 관리</p>
        </div>
        <div className="summary-area">
          <button type="button" className="ghost-btn theme-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "라이트 모드" : "다크 모드"}
          </button>
          <div className="summary-cards">
            <div className="summary-card">
              <span>Books</span>
              <strong>{books.length}</strong>
            </div>
            <div className="summary-card">
              <span>Pages</span>
              <strong>{totalPages}</strong>
            </div>
            <div className="summary-card">
              <span>Current OCR</span>
              <strong>{selectedBook ? `${ocrCompletionRate}%` : "-"}</strong>
            </div>
            <div className="summary-card">
              <span>Selected</span>
              <strong>{checkedPages.length}</strong>
            </div>
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
              <div className="progress-bar" style={{ width: `${uploadProgress}%` }} />
            </div>
          )}

          <input
            className="search-input"
            placeholder="책 이름 검색"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />

          <div className="book-list">
            {filteredBooks.length === 0 && <div className="empty">조건에 맞는 책이 없습니다.</div>}
            {filteredBooks.map((book) => (
              <div key={book.name} className={`book-item-row ${selectedBook === book.name ? "active" : ""}`}>
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
          {!selectedBook && <div className="empty viewer-empty">책을 선택하면 페이지 미리보기가 표시됩니다.</div>}

          {selectedBook && (
            <>
              <div className="panel-head viewer-head">
                <div>
                  <h2>{selectedBook}</h2>
                  <p>{selectedBookMeta?.pageCount || pages.length}페이지 등록됨</p>
                  <div className="meta-badges">
                    <span className="meta-badge">처리됨 {processedCount}</span>
                    <span className="meta-badge">OCR 보유 {ocrPages.length}</span>
                    <span className="meta-badge">전체 {pages.length}</span>
                  </div>
                </div>
                <div className="process-actions">
                  <button
                    type="button"
                    className="ghost-btn cancel-btn"
                    onClick={cancelProcess}
                    disabled={!isBusy || processPhase !== "running"}
                  >
                    공정 취소
                  </button>
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
                <label>
                  <input
                    type="checkbox"
                    checked={skipProcessedPages}
                    onChange={(event) => setSkipProcessedPages(event.target.checked)}
                    disabled={isBusy}
                  />
                  OCR 완료 페이지 건너뛰기
                </label>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={selectLowConfidence}
                  disabled={isBusy || lowConfidencePages.length === 0}
                >
                  저신뢰 페이지 선택 ({lowConfidencePages.length})
                </button>
                <span>{checkedPages.length}개 선택됨</span>
              </div>

              <div className="ocr-options">
                <div className="ocr-options-head">
                  <strong>OCR 옵션</strong>
                  <div className="ocr-options-actions">
                    <span>언어/PSM/후처리 설정</span>
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={saveOcrSettings}
                      disabled={isBusy || !selectedBook}
                    >
                      설정 저장
                    </button>
                  </div>
                </div>
                <div className="ocr-options-grid">
                  <label>
                    언어
                    <select value={ocrLang} onChange={(e) => setOcrLang(e.target.value)} disabled={isBusy}>
                      <option value="eng">eng</option>
                      <option value="kor">kor</option>
                      <option value="eng+kor">eng+kor</option>
                      <option value="jpn">jpn</option>
                      <option value="chi_sim">chi_sim</option>
                    </select>
                  </label>
                  <label>
                    PSM
                    <select value={ocrPsm} onChange={(e) => setOcrPsm(e.target.value)} disabled={isBusy}>
                      <option value="3">3 (자동)</option>
                      <option value="4">4 (단일 컬럼)</option>
                      <option value="6">6 (텍스트 블록)</option>
                      <option value="11">11 (스파스)</option>
                      <option value="12">12 (스파스+OSD)</option>
                    </select>
                  </label>
                  <label>
                    저신뢰 기준
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={confidenceThreshold}
                      onChange={(event) => setConfidenceThreshold(Number(event.target.value))}
                      disabled={isBusy}
                    />
                  </label>
                  <label className="inline-toggle">
                    <input
                      type="checkbox"
                      checked={postprocessRules.fixHyphenBreaks}
                      onChange={(event) =>
                        setPostprocessRules((prev) => ({ ...prev, fixHyphenBreaks: event.target.checked }))
                      }
                      disabled={isBusy}
                    />
                    하이픈 줄바꿈 정리
                  </label>
                  <label className="inline-toggle">
                    <input
                      type="checkbox"
                      checked={postprocessRules.preserveParagraphs}
                      onChange={(event) =>
                        setPostprocessRules((prev) => ({ ...prev, preserveParagraphs: event.target.checked }))
                      }
                      disabled={isBusy}
                    />
                    문단 유지
                  </label>
                  <label className="inline-toggle">
                    <input
                      type="checkbox"
                      checked={postprocessRules.joinLines}
                      onChange={(event) =>
                        setPostprocessRules((prev) => ({ ...prev, joinLines: event.target.checked }))
                      }
                      disabled={isBusy}
                    />
                    줄 합치기
                  </label>
                  <label className="inline-toggle">
                    <input
                      type="checkbox"
                      checked={postprocessRules.collapseWhitespace}
                      onChange={(event) =>
                        setPostprocessRules((prev) => ({ ...prev, collapseWhitespace: event.target.checked }))
                      }
                      disabled={isBusy}
                    />
                    공백 정리
                  </label>
                </div>
              </div>

              <div className="search-row">
                <input
                  className="search-input"
                  placeholder="OCR 텍스트 검색어"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  disabled={isBusy || isSearching}
                />
                <button type="button" className="ghost-btn" onClick={runOcrSearch} disabled={isBusy || isSearching}>
                  검색
                </button>
              </div>

              {searchResults.length > 0 && (
                <div className="search-results">
                  {searchResults.map((item) => (
                    <button
                      key={item.page}
                      type="button"
                      className="search-result-item"
                      onClick={() => setSelectedPage(item.page)}
                    >
                      <strong>{item.page}</strong>
                      <span>{item.excerpt || "미리보기 없음"}</span>
                    </button>
                  ))}
                </div>
              )}

              {(processPhase === "running" || processPhase === "completed") && processTotal > 0 && (
                <div className="process-progress-panel">
                  <div className="process-progress-head">
                    <span>공정 진행률</span>
                    <strong>
                      {processDone}/{processTotal}
                    </strong>
                  </div>
                  <div className="progress-wrap process-progress-wrap">
                    <div className="progress-bar process-progress-bar" style={{ width: `${processProgress}%` }} />
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
                  <div className="preview-top">
                    <div>
                      <strong>{selectedPage}</strong>
                      {selectedPageMeta && (
                        <div className="preview-meta">
                          <span>Conf {typeof selectedPageMeta.confidence === "number" ? `${Math.round(selectedPageMeta.confidence)}%` : "-"}</span>
                          <span>Lang {selectedPageMeta.lang || "-"}</span>
                          <span>PSM {selectedPageMeta.psm || "-"}</span>
                          {selectedPageMeta.edited && <span className="preview-meta-edited">수정됨</span>}
                        </div>
                      )}
                    </div>
                    <div className="preview-nav">
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() => setSelectedPage(pages[selectedPageIndex - 1])}
                        disabled={selectedPageIndex <= 0}
                      >
                        이전
                      </button>
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() => setSelectedPage(pages[selectedPageIndex + 1])}
                        disabled={selectedPageIndex < 0 || selectedPageIndex >= pages.length - 1}
                      >
                        다음
                      </button>
                    </div>
                  </div>
                  <img
                    src={`${API_BASE_URL}/uploads/${encodeURIComponent(selectedBook)}/${encodeURIComponent(
                      selectedPage
                    )}`}
                    alt={selectedPage}
                  />
                  <div className="preview-caption">
                    {selectedPageIndex + 1} / {pages.length}
                  </div>
                </div>
              ) : (
                <div className="empty">표시할 이미지 페이지가 없습니다.</div>
              )}

              <div className="ocr-editor">
                <div className="ocr-editor-head">
                  <strong>선택 페이지 OCR 편집</strong>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={saveSelectedPageOcr}
                    disabled={isBusy || isLoadingOcrEditor || isSavingOcrEditor || !selectedPage}
                  >
                    OCR 저장
                  </button>
                </div>
                <textarea
                  value={ocrEditorText}
                  onChange={(event) => setOcrEditorText(event.target.value)}
                  placeholder={
                    selectedPage
                      ? "OCR 결과가 없으면 공정을 먼저 실행하거나 직접 입력해 저장하세요."
                      : "페이지를 선택하면 OCR 텍스트를 편집할 수 있습니다."
                  }
                  disabled={!selectedPage || isBusy || isLoadingOcrEditor || isSavingOcrEditor}
                />
              </div>

              <div
                className="thumb-grid-viewport"
                ref={thumbGridViewportRef}
                onScroll={(event) =>
                  setThumbViewport((prev) => ({
                    ...prev,
                    scrollTop: event.currentTarget.scrollTop,
                  }))
                }
              >
                <div className="thumb-grid-spacer" style={{ height: `${thumbTotalHeight}px` }}>
                  {visibleThumbs.map((item) => {
                    const meta = ocrMeta?.[item.page];
                    const isLowConfidence = lowConfidencePages.includes(item.page);
                    return (
                      <div
                        key={item.page}
                        className={`thumb virtual-thumb ${selectedPage === item.page ? "active" : ""} ${
                          isLowConfidence ? "low-confidence" : ""
                        }`}
                        style={{
                          width: `${thumbCellWidth}px`,
                          height: `${THUMB_HEIGHT}px`,
                          top: `${item.top}px`,
                          left: `${item.left}px`,
                        }}
                        onClick={() => setSelectedPage(item.page)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedPage(item.page);
                          }
                        }}
                      >
                        {isLowConfidence && <span className="thumb-badge">Low</span>}
                        <img
                          src={`${API_BASE_URL}/uploads/${encodeURIComponent(selectedBook)}/${encodeURIComponent(
                            item.page
                          )}`}
                          alt={item.page}
                        />
                        <span className={processedPages.includes(item.page) ? "thumb-name processed" : "thumb-name"}>
                          {item.page}
                        </span>
                        <span className="thumb-meta">
                          {typeof meta?.confidence === "number" ? `Conf ${Math.round(meta.confidence)}%` : "Conf -"}
                        </span>
                        <label className="thumb-check" onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={checkedPages.includes(item.page)}
                            onChange={() => togglePageCheck(item.page)}
                            disabled={isBusy}
                          />
                          선택
                        </label>
                        <button
                          type="button"
                          className="thumb-download-btn"
                          onClick={(event) => {
                            event.stopPropagation();
                            downloadPageOcr(item.page);
                          }}
                          disabled={isBusy || !ocrPages.includes(item.page)}
                        >
                          txt 다운로드
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
