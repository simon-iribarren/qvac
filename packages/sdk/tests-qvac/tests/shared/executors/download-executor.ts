import {
  downloadAsset,
  cancel,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
} from "@qvac/sdk";
import {
  BaseExecutor,
  type TestResult,
} from "@tetherto/qvac-test-suite";
import {
  downloadParallel,
  downloadCancelIsolation,
} from "../../download-tests.js";

const downloadTests = [downloadParallel, downloadCancelIsolation] as const;

export class DownloadExecutor extends BaseExecutor<typeof downloadTests> {
  pattern = /^download-/;

  protected handlers = {
    [downloadParallel.testId]: this.parallel.bind(this),
    [downloadCancelIsolation.testId]: this.cancelIsolation.bind(this),
  };

  async parallel(
    params: typeof downloadParallel.params,
    expectation: typeof downloadParallel.expectation,
  ): Promise<TestResult> {
    const assets = [
      { name: "Whisper Tiny", src: WHISPER_TINY },
      { name: "VAD Silero", src: VAD_SILERO_5_1_2 },
    ];

    const results = await Promise.all(
      assets.map((asset) =>
        downloadAsset({ assetSrc: asset.src, onProgress: () => {} }).then(
          (id) => ({ name: asset.name, status: "ok" as const, id }),
          (err: unknown) => ({
            name: asset.name,
            status: "fail" as const,
            err: err instanceof Error ? err.message : String(err),
          }),
        ),
      ),
    );

    const succeeded = results.filter((r) => r.status === "ok");
    const detail = results
      .map((r) =>
        r.status === "ok"
          ? `${r.name}: OK (${r.id})`
          : `${r.name}: FAILED (${r.err})`,
      )
      .join(", ");

    const passed = succeeded.length === assets.length;

    return { passed, output: `${succeeded.length}/${results.length} succeeded. ${detail}` };
  }

  async cancelIsolation(
    params: typeof downloadCancelIsolation.params,
    expectation: typeof downloadCancelIsolation.expectation,
  ): Promise<TestResult> {
    let cancelTriggered = false;

    const survivorPromise = downloadAsset({
      assetSrc: WHISPER_TINY,
      onProgress: () => {},
    }).then(
      (id) => ({ status: "ok" as const, id }),
      (err: unknown) => ({
        status: "fail" as const,
        err: err instanceof Error ? err.message : String(err),
      }),
    );

    const cancelledPromise = downloadAsset({
      assetSrc: VAD_SILERO_5_1_2,
      onProgress: (p: { downloadKey?: string; percentage: number }) => {
        if (
          !cancelTriggered &&
          p.downloadKey &&
          p.percentage >= (params.cancelAtPercent ?? 1)
        ) {
          cancelTriggered = true;
          void cancel({
            operation: "downloadAsset",
            downloadKey: p.downloadKey,
            clearCache: true,
          });
        }
      },
    }).then(
      (id) => ({ status: "ok" as const, id }),
      (err: unknown) => ({
        status: "fail" as const,
        err: err instanceof Error ? err.message : String(err),
      }),
    );

    const [survivor, cancelled] = await Promise.all([
      survivorPromise,
      cancelledPromise,
    ]);

    const survivorOk = survivor.status === "ok";
    const cancelledFailed = cancelled.status === "fail";

    const survivorDetail =
      survivor.status === "ok"
        ? `OK (${survivor.id})`
        : `FAILED (${survivor.err})`;
    const cancelledDetail =
      cancelled.status === "fail"
        ? `correctly rejected (${cancelled.err})`
        : `should have been cancelled but succeeded (${cancelled.id})`;

    return {
      passed: survivorOk && cancelledFailed,
      output: `Survivor (Whisper): ${survivorDetail}. Cancelled (VAD): ${cancelledDetail}`,
    };
  }
}
