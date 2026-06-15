// Thin wrapper over the preload bridge (window.api). Components and hooks
// import this instead of touching the global directly — keeps the IPC surface
// in one place and easy to mock/replace.
const api = window.api ?? {}

export default api
