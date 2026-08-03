import { createRoot } from "react-dom/client";

import "@fontsource/open-sans/400.css";
import "@fontsource/open-sans/600.css";
import "./styles.css";

import { App } from "./App.jsx";

createRoot(document.getElementById("root")).render(<App />);
