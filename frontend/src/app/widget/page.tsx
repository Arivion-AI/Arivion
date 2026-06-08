// Widget gallery route — preview/iterate every Copilot widget with mock data at /widget.
// Wrap in `.nexa` so the copilot theme variables (--bg/--panel/--ink/--line…) resolve exactly as on
// the Copilot board — otherwise the cards render unthemed and look nothing like the real thing.
import "../netrunners/copilot/nexa.css";
import WidgetGallery from "@/components/copilot/WidgetGallery";

export default function WidgetGalleryPage() {
  // Keep `.nexa` for its theme variables + box-sizing, but override its fixed 3-column app-shell grid
  // to a normal full-page block so the gallery uses the whole viewport (not the 252px sidebar track).
  return (
    <div className="nexa" style={{ position: "static", inset: "auto", display: "block", width: "100%", height: "100vh" }}>
      <WidgetGallery />
    </div>
  );
}
