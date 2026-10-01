import { useState } from "react";
import { readIdBarcode } from "@west4/shared";
import { api } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Scan ID (M2-12; spec 04 · id_checks): the camera and the browser's own
 * barcode reader on this device read the ID's PDF417 code; only the four
 * fields leave the device, and no ID vendor's cloud is ever called. Where the
 * browser has no barcode reader, staff check the ID by eye.
 */
interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
type DetectorCtor = new (options: { formats: string[] }) => Detector;

const SCAN_FOR_MS = 20_000;

export function ScanId({
  venueId,
  sessionId,
  onScanned,
}: {
  venueId: string;
  sessionId: string;
  onScanned: () => void;
}) {
  const { t } = useT();
  const [status, setStatus] = useState<
    "idle" | "scanning" | "done" | "unsupported" | "not_an_id" | "failed"
  >("idle");

  const scan = async () => {
    const Ctor = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    if (!Ctor || !navigator.mediaDevices?.getUserMedia) {
      setStatus("unsupported");
      return;
    }
    setStatus("scanning");
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      const detector = new Ctor({ formats: ["pdf417"] });
      const until = Date.now() + SCAN_FOR_MS;
      while (Date.now() < until) {
        const codes = await detector.detect(video);
        const fields = codes.map((c) => readIdBarcode(c.rawValue)).find((f) => f !== null);
        if (fields) {
          await api("POST", `/v1/venues/${venueId}/sessions/${sessionId}/id-checks`, {
            method: "scan",
            fields,
          });
          setStatus("done");
          onScanned();
          return;
        }
        if (codes.length > 0) setStatus("not_an_id");
        await new Promise((done) => setTimeout(done, 400));
      }
      setStatus("not_an_id");
    } catch {
      setStatus("failed");
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  };

  const words = {
    idle: null,
    scanning: t("ids.scanning"),
    done: t("ids.scanned"),
    unsupported: t("ids.unsupported"),
    not_an_id: t("ids.notAnId"),
    failed: t("ids.failed"),
  }[status];
  return (
    <div className="row">
      <button
        type="button"
        className="secondary"
        disabled={status === "scanning"}
        onClick={() => void scan()}
      >
        {t("ids.scan")}
      </button>
      {words && (
        <span className="small" role="status">
          {words}
        </span>
      )}
    </div>
  );
}
