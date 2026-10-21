import { PdfViewer, type PdfLoader } from "@drm/renderer";
import type { OpenedDocument } from "../../shared/ipc.js";

interface Props {
  doc: OpenedDocument;
  onClose: () => void;
  /** 테스트에서 pdf.js 대체 */
  loader?: PdfLoader;
}

export const ViewerScreen = ({ doc, onClose, loader }: Props) => (
  <main className="page viewer">
    <header className="topbar">
      <strong>{doc.fileName}</strong>
      <span className="spacer" />
      <button type="button" onClick={onClose}>
        닫기
      </button>
    </header>
    <div className="viewer__body">
      {doc.contentType === "application/pdf" ? (
        <PdfViewer data={doc.data} watermark={doc.watermark} {...(loader ? { loader } : {})} />
      ) : (
        <p className="center">이 버전의 뷰어는 3D 모델을 지원하지 않습니다.</p>
      )}
    </div>
  </main>
);
