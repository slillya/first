import { useEffect, useRef } from "preact/hooks";
import { doc, gridStep, initKernel, kernelError, kernelPhase, mode, toast } from "../model/store";
import { createViewport } from "../view/Viewport";
import { Composer, ReplyBubble } from "./Composer";
import { DimLabels } from "./DimLabels";
import { FeatureTree } from "./FeatureTree";
import { BottomCard } from "./Sheets";
import { Toolbox } from "./Toolbox";

export function App() {
  const stage = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const vp = createViewport(stage.current!);
    initKernel();
    // Tell the viewport how much of the screen the chat area covers so "fit" centres the part above it.
    const ro = new ResizeObserver(() => {
      const h = bottom.current?.offsetHeight ?? 96;
      vp.insets.bottom = Math.min(h + 12, stage.current!.clientHeight * 0.5);
    });
    ro.observe(bottom.current!);
    return () => ro.disconnect();
  }, []);

  const phase = kernelPhase.value;
  const empty = doc.value.features.length === 0 && mode.value.kind === "model";

  return (
    <div class="stage" ref={stage}>
      <DimLabels />
      {phase === "loading" && (
        <div class="center-note">
          <span class="spinner" /> Loading the CAD kernel…
        </div>
      )}
      {phase === "failed" && kernelError.value && (
        <div class="center-note quiet">
          <b>The CAD kernel could not start.</b>
          <br />
          {kernelError.value}
        </div>
      )}
      {phase !== "loading" && !kernelError.value && empty && (
        <div class="center-note quiet">
          Open <b>Tools</b> to start a sketch,
          <br />
          or tell Claude what to make.
        </div>
      )}
      <div class="top">
        <FeatureTree />
        <Toolbox />
      </div>
      {mode.value.kind === "sketch" && <div class="grid-note">grid {gridStep.value} mm</div>}
      {toast.value && (
        <div class="toast" role="status" key={toast.value.id}>
          {toast.value.text}
        </div>
      )}
      <div class="bottom" ref={bottom}>
        <ReplyBubble />
        <BottomCard />
        <Composer />
      </div>
    </div>
  );
}
