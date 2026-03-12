import React, { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import "./App.css";

const API_BASE_URL = process.env.REACT_APP_API_URL || "";
const THUMB_MIN_WIDTH = 130;
const THUMB_GAP = 10;
const THUMB_HEIGHT = 214;
const THUMB_OVERSCAN_ROWS = 2;
const QUEUE_STORAGE_KEY = "book-ocr-upload-queue";
const QUEUE_DB_NAME = "book-ocr-upload-queue";
const QUEUE_DB_VERSION = 1;
const QUEUE_DB_STORE = "queue-files";
const QUEUE_LIMIT_MB = Number(process.env.REACT_APP_UPLOAD_QUEUE_LIMIT_MB) || 400;
const QUEUE_LIMIT_BYTES = QUEUE_LIMIT_MB * 1024 * 1024;

const openQueueDb = () =>
  new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const request = indexedDB.open(QUEUE_DB_NAME, QUEUE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(QUEUE_DB_STORE)) {
        db.createObjectStore(QUEUE_DB_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });

const putQueueFiles = async (id, files) => {
  const db = await openQueueDb();
  if (!db) {
    return false;
  }
  return new Promise((resolve) => {
    const tx = db.transaction(QUEUE_DB_STORE, "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.objectStore(QUEUE_DB_STORE).put({ id, files });
  });
};

const getQueueFiles = async (id) => {
  const db = await openQueueDb();
  if (!db) {
    return null;
  }
  return new Promise((resolve) => {
    const tx = db.transaction(QUEUE_DB_STORE, "readonly");
    const req = tx.objectStore(QUEUE_DB_STORE).get(id);
    req.onsuccess = () => resolve(req.result?.files || null);
    req.onerror = () => resolve(null);
  });
};

const deleteQueueFiles = async (id) => {
  const db = await openQueueDb();
  if (!db) {
    return false;
  }
  return new Promise((resolve) => {
    const tx = db.transaction(QUEUE_DB_STORE, "readwrite");
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.objectStore(QUEUE_DB_STORE).delete(id);
  });
};

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
  const [isOffline, setIsOffline] = useState(() => {
    if (typeof navigator === "undefined") {
      return false;
    }
    return !navigator.onLine;
  });
  const [uploadQueue, setUploadQueue] = useState([]);
  const [toast, setToast] = useState({ message: "", type: "info", visible: false });
  const [expandedQueueIds, setExpandedQueueIds] = useState(new Set());
  const [queueSearch, setQueueSearch] = useState("");
  const [queueSort, setQueueSort] = useState("name-asc");
  const [pendingCleanup, setPendingCleanup] = useState(false);
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
  const [savedOcrSettings, setSavedOcrSettings] = useState(null);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [isInstalled, setIsInstalled] = useState(false);
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
  const toastTimerRef = useRef(null);
  const uploadQueueRef = useRef([]);
  const isProcessingQueueRef = useRef(false);

  useEffect(() => {
    fetchBooks();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const saved = window.localStorage.getItem(QUEUE_STORAGE_KEY);
    if (!saved) {
      return;
    }
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        const hydrated = parsed.map((item) => ({
          ...item,
          files: null,
        }));
        setUploadQueue(hydrated);
      }
    } catch (_err) {
      // Ignore corrupted storage
    }
  }, []);

  useEffect(() => {
    uploadQueueRef.current = uploadQueue;
  }, [uploadQueue]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const serializable = uploadQueue.map(({ files, ...rest }) => rest);
    window.localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(serializable));
  }, [uploadQueue]);

  useEffect(() => {
    const idSet = new Set(uploadQueue.map((item) => item.id));
    setExpandedQueueIds((prev) => {
      const next = new Set();
      prev.forEach((id) => {
        if (idSet.has(id)) {
          next.add(id);
        }
      });
      return next;
    });
  }, [uploadQueue.length]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const handleOnline = () => {
      setIsOffline(false);
      setStatus("네트워크 복구됨. 대기열을 처리합니다.");
      showToast("네트워크 복구됨. 업로드를 재시도합니다.", "success");
    };

    const handleOffline = () => {
      setIsOffline(true);
      setStatus("오프라인 상태입니다. 업로드는 대기열에 저장됩니다.");
      showToast("오프라인 상태입니다. 업로드가 대기열에 저장됩니다.", "warn");
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    const onBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const onAppInstalled = () => {
      setIsInstalled(true);
      setInstallPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
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
    if (!ocrMeta || typeof ocrMeta !== "object") {
      setLowConfidencePages([]);
      return;
    }
    const recalculated = pages.filter((page) => {
      const confidence = ocrMeta?.[page]?.confidence;
      return typeof confidence === "number" && confidence < confidenceThreshold;
    });
    setLowConfidencePages(recalculated);
  }, [ocrMeta, pages, confidenceThreshold]);

  useEffect(() => {
    if (toastTimerRef.current) {
      return () => clearTimeout(toastTimerRef.current);
    }
    return undefined;
  }, [toast.visible]);

  useEffect(() => {
    if (isOffline || isBusy || uploadQueue.length === 0) {
      return;
    }
    processUploadQueue();
  }, [isOffline, isBusy, uploadQueue.length]);

  const showToast = (message, type = "info", duration = 3500) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setToast({ message, type, visible: true });
    toastTimerRef.current = setTimeout(() => {
      setToast((prev) => ({ ...prev, visible: false }));
    }, duration);
  };

  const enqueueUpload = async (files, reason = "offline") => {
    const safeFiles = Array.isArray(files) ? files : [];
    if (safeFiles.length === 0) {
      return;
    }
    const filesMeta = safeFiles.map((file) => ({
      name: file.name,
      size: file.size,
      path: file.webkitRelativePath || file.name,
    }));
    const item = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      files: safeFiles,
      filesMeta,
      fileCount: safeFiles.length,
      createdAt: new Date().toISOString(),
      reason,
    };
    setUploadQueue((prev) => [...prev, item]);
    const stored = await putQueueFiles(item.id, safeFiles);
    if (!stored) {
      setUploadQueue((prev) =>
        prev.map((queued) => (queued.id === item.id ? { ...queued, persisted: false } : queued))
      );
      showToast("브라우저 저장소에 파일을 보관하지 못했습니다. 재시작 시 업로드가 사라질 수 있어요.", "warn");
    } else {
      setUploadQueue((prev) =>
        prev.map((queued) => (queued.id === item.id ? { ...queued, persisted: true } : queued))
      );
    }
    setStatus(`업로드 대기열에 추가됨 (${safeFiles.length}개 파일)`);
  };

  const uploadFiles = async (files, { fromQueue = false } = {}) => {
    if (!files || files.length === 0) {
      return true;
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
      setStatus(`${fromQueue ? "대기열 업로드" : "업로드"} 중... (${files.length}개 파일)`);

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
      showToast("업로드가 완료되었습니다.", "success");
      return true;
    } catch (err) {
      const isNetworkError = !err?.response;
      if (isNetworkError) {
        if (!fromQueue) {
          await enqueueUpload(files, "network");
        }
        setStatus("네트워크 문제로 업로드가 대기열에 보류되었습니다.");
        showToast("네트워크 오류로 업로드가 대기열에 추가되었습니다.", "warn");
      } else {
        setError("업로드에 실패했습니다. 폴더 선택과 서버 연결을 확인해 주세요.");
        showToast("업로드 실패: 서버 응답 오류", "error");
      }
      return false;
    } finally {
      setIsBusy(false);
      setUploadProgress(0);
    }
  };

  const resolveQueueFiles = async (item) => {
    if (item?.files && item.files.length > 0) {
      return item.files;
    }
    const stored = await getQueueFiles(item?.id);
    return Array.isArray(stored) ? stored : null;
  };

  const removeQueueItem = async (id) => {
    if (!id) {
      return;
    }
    await deleteQueueFiles(id);
    setUploadQueue((prev) => prev.filter((item) => item.id !== id));
  };

  const clearQueue = async () => {
    const ids = uploadQueueRef.current.map((item) => item.id);
    for (const id of ids) {
      await deleteQueueFiles(id);
    }
    setUploadQueue([]);
    showToast("업로드 대기열을 모두 비웠습니다.", "info");
  };

  const toggleQueueItem = (id) => {
    setExpandedQueueIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const approximateQueueBytes = useMemo(() => {
    return uploadQueue.reduce((sum, item) => {
      if (Array.isArray(item.filesMeta)) {
        return sum + item.filesMeta.reduce((acc, meta) => acc + (meta.size || 0), 0);
      }
      return sum;
    }, 0);
  }, [uploadQueue]);

  const cleanupQueueBySize = async () => {
    setUploadQueue((prev) => {
      let total = prev.reduce((sum, item) => {
        if (!Array.isArray(item.filesMeta)) {
          return sum;
        }
        return sum + item.filesMeta.reduce((acc, meta) => acc + (meta.size || 0), 0);
      }, 0);
      const next = [...prev];
      while (next.length > 0 && total > QUEUE_LIMIT_BYTES) {
        const removed = next.shift();
        if (removed?.filesMeta) {
          const removedBytes = removed.filesMeta.reduce((acc, meta) => acc + (meta.size || 0), 0);
          total -= removedBytes;
          deleteQueueFiles(removed.id);
        }
      }
      return next;
    });
  };

  useEffect(() => {
    if (approximateQueueBytes <= 0) {
      return;
    }
    if (approximateQueueBytes > QUEUE_LIMIT_BYTES && !pendingCleanup) {
      setPendingCleanup(true);
    }
  }, [approximateQueueBytes, pendingCleanup]);

  const formatQueueBytes = (bytes) => {
    if (!bytes) {
      return "0MB";
    }
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)}MB`;
  };

  const getSortedFiles = (filesMeta) => {
    const files = Array.isArray(filesMeta) ? [...filesMeta] : [];
    const trimmedQuery = queueSearch.trim().toLowerCase();
    const filtered = trimmedQuery
      ? files.filter((meta) => (meta.path || meta.name || "").toLowerCase().includes(trimmedQuery))
      : files;
    const [key, direction] = queueSort.split("-");
    const multiplier = direction === "desc" ? -1 : 1;
    return filtered.sort((a, b) => {
      if (key === "size") {
        return ((a.size || 0) - (b.size || 0)) * multiplier;
      }
      return (a.name || "").localeCompare(b.name || "") * multiplier;
    });
  };

  const retryQueueItem = async (id) => {
    if (isOffline || isBusy) {
      return;
    }
    const target = uploadQueueRef.current.find((item) => item.id === id);
    if (!target) {
      return;
    }
    const files = await resolveQueueFiles(target);
    if (!files || files.length === 0) {
      await removeQueueItem(id);
      showToast("업로드 파일을 찾을 수 없어 대기열에서 제거했습니다.", "error");
      return;
    }
    const ok = await uploadFiles(files, { fromQueue: true });
    if (ok) {
      await removeQueueItem(id);
    }
  };

  const processUploadQueue = async () => {
    if (isProcessingQueueRef.current) {
      return;
    }
    isProcessingQueueRef.current = true;

    try {
      while (!isOffline && !isBusy && uploadQueueRef.current.length > 0) {
        const nextItem = uploadQueueRef.current[0];
        if (!nextItem) {
          break;
        }
        const files = await resolveQueueFiles(nextItem);
        if (!files || files.length === 0) {
          await removeQueueItem(nextItem.id);
          showToast("업로드 파일을 찾을 수 없어 대기열에서 제거했습니다.", "error");
          continue;
        }
        const ok = await uploadFiles(files, { fromQueue: true });
        if (!ok) {
          break;
        }
        await removeQueueItem(nextItem.id);
      }
    } finally {
      isProcessingQueueRef.current = false;
    }
  };

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
        if (typeof newSettings.confidenceThreshold === "number") {
          setConfidenceThreshold(newSettings.confidenceThreshold);
        }
        setSavedOcrSettings({
          confidenceThreshold: Number(newSettings.confidenceThreshold) || 80,
          lang: newSettings.lang || "eng",
          psm: String(newSettings.psm || "6"),
          postprocessRules: { ...newSettings.postprocessRules },
        });
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
        if (typeof nextSettings.confidenceThreshold === "number") {
          setConfidenceThreshold(nextSettings.confidenceThreshold);
        }
        setSavedOcrSettings({
          confidenceThreshold: Number(nextSettings.confidenceThreshold) || 80,
          lang: nextSettings.lang || "eng",
          psm: String(nextSettings.psm || "6"),
          postprocessRules: { ...nextSettings.postprocessRules },
        });
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

    if (isOffline) {
      await enqueueUpload(files, "offline");
      showToast("오프라인 상태로 업로드가 대기열에 저장되었습니다.", "warn");
      e.target.value = "";
      return;
    }

    await uploadFiles(files);
    e.target.value = "";
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

  const handleInstall = async () => {
    if (!installPrompt) {
      return;
    }
    installPrompt.prompt();
    try {
      await installPrompt.userChoice;
    } catch (_error) {
      // Ignore install errors.
    } finally {
      setInstallPrompt(null);
    }
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
        setSavedOcrSettings({
          confidenceThreshold: Number(settings.confidenceThreshold) || 80,
          lang: settings.lang || "eng",
          psm: String(settings.psm || "6"),
          postprocessRules: { ...settings.postprocessRules },
        });
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
  const hasUnsavedSettings =
    !savedOcrSettings ||
    savedOcrSettings.confidenceThreshold !== confidenceThreshold ||
    savedOcrSettings.lang !== ocrLang ||
    String(savedOcrSettings.psm) !== String(ocrPsm) ||
    Object.keys(postprocessRules).some(
      (key) => postprocessRules[key] !== savedOcrSettings.postprocessRules?.[key]
    );
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
          {installPrompt && !isInstalled && (
            <button type="button" className="ghost-btn install-btn" onClick={handleInstall}>
              앱 설치
            </button>
          )}
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

      {isOffline && (
        <div className="offline-banner">
          오프라인 모드입니다. 업로드는 대기열에 저장되며 네트워크 복구 시 자동 재시도됩니다.
          {uploadQueue.length > 0 && (
            <span className="offline-queue">대기열 {uploadQueue.length}건</span>
          )}
        </div>
      )}

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

          {uploadQueue.length > 0 && (
            <div className="queue-panel">
              <div className="queue-head">
                <strong>업로드 대기열</strong>
                <div className="queue-head-actions">
                  <span>{uploadQueue.length}건 · {formatQueueBytes(approximateQueueBytes)}</span>
                  <button type="button" className="ghost-btn danger" onClick={clearQueue} disabled={isBusy}>
                    전체 삭제
                  </button>
                </div>
              </div>
              <div className="queue-controls">
                <input
                  className="queue-search"
                  placeholder="파일 검색"
                  value={queueSearch}
                  onChange={(e) => setQueueSearch(e.target.value)}
                />
                <select
                  className="queue-sort"
                  value={queueSort}
                  onChange={(e) => setQueueSort(e.target.value)}
                >
                  <option value="name-asc">이름 ↑</option>
                  <option value="name-desc">이름 ↓</option>
                  <option value="size-asc">크기 ↑</option>
                  <option value="size-desc">크기 ↓</option>
                </select>
              </div>
              <div className="queue-list">
                {uploadQueue.map((item) => {
                  const displayName = item.filesMeta?.[0]?.name || "파일 묶음";
                  const extraCount = (item.filesMeta?.length || item.fileCount || 1) - 1;
                  const isExpanded = expandedQueueIds.has(item.id);
                  const sortedFiles = isExpanded ? getSortedFiles(item.filesMeta) : [];
                  return (
                    <div key={item.id} className="queue-item">
                      <div className="queue-info">
                        <strong>{item.fileCount || item.filesMeta?.length || 0}개 파일</strong>
                        <span>
                          {displayName}
                          {extraCount > 0 ? ` 외 ${extraCount}개` : ""}
                        </span>
                        {item.createdAt && (
                          <span className="queue-meta">
                            {new Date(item.createdAt).toLocaleString()}
                          </span>
                        )}
                        {item.persisted === false && <span className="queue-warn">재시작 시 유실 가능</span>}
                        {Array.isArray(item.filesMeta) && item.filesMeta.length > 0 && (
                          <button
                            type="button"
                            className="queue-toggle"
                            onClick={() => toggleQueueItem(item.id)}
                          >
                            {isExpanded ? "파일 숨기기" : "파일 목록 보기"}
                          </button>
                        )}
                        {isExpanded && Array.isArray(item.filesMeta) && (
                          <div className="queue-files">
                            {sortedFiles.map((meta, index) => (
                              <span key={`${item.id}-${meta.name}-${index}`}>
                                {meta.path || meta.name} ({Math.round((meta.size || 0) / 1024)}KB)
                              </span>
                            ))}
                            {sortedFiles.length === 0 && <span>검색 결과가 없습니다.</span>}
                          </div>
                        )}
                      </div>
                      <div className="queue-actions">
                        <button
                          type="button"
                          className="ghost-btn"
                          onClick={() => retryQueueItem(item.id)}
                          disabled={isOffline || isBusy}
                        >
                          재시도
                        </button>
                        <button
                          type="button"
                          className="ghost-btn danger"
                          onClick={() => removeQueueItem(item.id)}
                          disabled={isBusy}
                        >
                          삭제
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
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
            {uploadQueue.length > 0 && (
              <div className="queue-hint">업로드 대기열: {uploadQueue.length}건</div>
            )}
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
                    {hasUnsavedSettings && <span className="ocr-settings-dirty">변경됨</span>}
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
                onScroll={(event) => {
                  const nextScrollTop = event.currentTarget ? event.currentTarget.scrollTop : 0;
                  setThumbViewport((prev) => ({
                    ...prev,
                    scrollTop: nextScrollTop,
                  }));
                }}
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

      <div className={`toast ${toast.type} ${toast.visible ? "show" : ""}`} role="status" aria-live="polite">
        {toast.message}
      </div>

      {pendingCleanup && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="queue-cleanup-title">
            <h3 id="queue-cleanup-title">업로드 대기열 용량 초과</h3>
            <p>
              현재 대기열은 {formatQueueBytes(approximateQueueBytes)}로 설정된 한도(
              {QUEUE_LIMIT_MB}MB)를 초과했습니다. 오래된 항목부터 자동 정리할까요?
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="ghost-btn danger"
                onClick={async () => {
                  await cleanupQueueBySize();
                  setPendingCleanup(false);
                  showToast("대기열을 정리했습니다.", "info");
                }}
              >
                정리하기
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  setPendingCleanup(false);
                }}
              >
                나중에
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
