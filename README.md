# university-OCR-project

대학교 프로젝트용 OCR 처리 웹 애플리케이션입니다.  
`frontend`(React)와 `backend`(Express + Tesseract.js)로 구성된 단일 저장소(monorepo)입니다.

## 구조

- `frontend`: UI, 업로드/공정 실행/다운로드 화면
- `backend`: 업로드 API, OCR 처리 API, 다운로드 API

## 실행 방법

### 1) Backend

```bash
cd backend
npm install
npm start
```

- 기본 포트: `5001`
- 헬스체크: `http://localhost:5001/health`

### 2) Frontend

```bash
cd frontend
npm install
npm start
```

- 기본 포트: `3000`
- 개발 환경에서 `frontend/package.json`의 `proxy`를 통해 backend(`5001`)와 통신합니다.

## 주요 기능

- 폴더 단위 이미지 업로드
- 책/페이지 단위 OCR 공정 실행
- SSE 기반 공정 진행률 표시
- 페이지별 OCR txt 다운로드
- OCR 합본 txt 다운로드

## 참고

- OCR 언어는 backend의 `OCR_LANG` 환경변수로 지정할 수 있습니다. (기본값: `eng`)
- 업로드/임시 파일(`backend/uploads`, `backend/temp`)은 `.gitignore`에 포함되어 있습니다.
