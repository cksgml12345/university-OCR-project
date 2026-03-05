import { render, screen } from "@testing-library/react";
import App from "./App";

jest.mock("axios", () => ({
  get: jest.fn(() => Promise.resolve({ data: [] })),
  post: jest.fn(() => Promise.resolve({ data: {} })),
  put: jest.fn(() => Promise.resolve({ data: {} })),
  delete: jest.fn(() => Promise.resolve({ data: {} })),
}));
const axios = require("axios");

test("renders app title", () => {
  axios.get.mockResolvedValue({ data: [] });
  render(<App />);
  expect(screen.getByText(/Book Processing Console/i)).toBeInTheDocument();
});

test("renders book search input", async () => {
  axios.get.mockResolvedValue({ data: [] });
  render(<App />);
  expect(await screen.findByPlaceholderText("책 이름 검색")).toBeInTheDocument();
});
