import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";

document.addEventListener("contextmenu", (e) => {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag !== "INPUT" && tag !== "TEXTAREA") e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
