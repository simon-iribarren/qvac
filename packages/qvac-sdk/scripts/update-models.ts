import fs from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { QVACRegistryClient } from "@tetherto/qvac-lib-registry-client";
import type { QVACModelEntry } from "@tetherto/qvac-lib-registry-client";
import {
  getAddonFromEngine,
  resolveCanonicalEngine,
} from "../schemas/engine-addon-map";
import type { QvacModelRegistryEntryAddon } from "../schemas/registry";

// Default QVAC Registry core key - this is the public registry that contains all QVAC models
const DEFAULT_REGISTRY_CORE_KEY =
  "87artu7udixab7hy4wf9m6gjdkfihjw34da8orib8phd986amseo";

const OUTPUT_FILE = fileURLToPath(
  new URL("../models/hyperdrive/models.ts", import.meta.url),
);
const HISTORY_DIR = fileURLToPath(
  new URL("../models/history", import.meta.url),
);

// --- Types ---

interface ShardInfo {
  isSharded: true;
  baseFilename: string;
  currentShard: number;
  totalShards: number;
  extension: string;
}

interface NotSharded {
  isSharded: false;
}

type ShardDetection = ShardInfo | NotSharded;

interface ShardMetadataEntry {
  filename: string;
  expectedSize: number;
  sha256Checksum: string;
  blobCoreKey: string;
  blobBlockOffset: number;
  blobBlockLength: number;
  blobByteOffset: number;
}

interface ProcessedModel {
  registryPath: string;
  registrySource: string;
  blobCoreKey: string;
  blobBlockOffset: number;
  blobBlockLength: number;
  blobByteOffset: number;
  modelId: string;
  addon: QvacModelRegistryEntryAddon;
  expectedSize: number;
  sha256Checksum: string;
  engine: string;
  modelName: string;
  quantization: string;
  params: string;
  isShardPart?: boolean;
  shardInfo?: ShardInfo;
  shardMetadata?: ShardMetadataEntry[];
  name?: string;
}

interface CurrentModel {
  name: string;
  registryPath: string;
}

interface CollectOptions {
  showDuplicates?: boolean;
  noDedup?: boolean;
}

// --- Helpers ---

function detectShardedModel(filename: string): ShardDetection {
  const shardPattern = /^(.+)-(\d{5})-of-(\d{5})(\.\w+)$/;
  const match = filename.match(shardPattern);

  if (match) {
    return {
      isSharded: true,
      baseFilename: match[1]!,
      currentShard: parseInt(match[2]!, 10),
      totalShards: parseInt(match[3]!, 10),
      extension: match[4]!,
    };
  }

  return { isSharded: false };
}

function generateExportName({
  path: registryPath,
  engine,
  name,
  quantization,
  usedNames,
}: {
  path: string;
  engine: string;
  name: string;
  quantization: string;
  usedNames: Set<string>;
}): string {
  function cleanPart(p: string): string {
    if (!p) return "";
    return p
      .replace(/ggml-?/gi, "")
      .replace(/gguf-?/gi, "")
      .replace(/instruct/gi, "inst")
      .replace(/^-+|-+$/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_");
  }

  const addon = getAddonFromEngine(engine);
  let exportName = "";

  const filename = registryPath.split("/").pop() || registryPath;

  if (addon === "whisper") {
    const sizeMatch = filename.match(
      /\b(tiny|base|small|medium|large(?:-v[0-9]+)?(?:-turbo)?)\b/i,
    );
    const modelSize = sizeMatch ? sizeMatch[1]! : "";

    const langMatch = filename.match(/\.(en)\b/i);
    const lang = langMatch ? langMatch[1]! : "";

    const nameParts = [modelSize, lang, quantization].filter(
      (p) => p && p !== "",
    );
    exportName = `WHISPER_${nameParts.map(cleanPart).join("_")}`;
  } else if (addon === "vad") {
    const nameParts = [name].filter((p) => p && p !== "");
    exportName = `VAD_${nameParts.map(cleanPart).join("_")}`;
  } else if (addon === "nmt") {
    const lowerFilename = filename.toLowerCase();
    const lowerPath = registryPath.toLowerCase();

    if (
      lowerPath.includes("salamandra") ||
      lowerFilename.includes("salamandra")
    ) {
      const nameParts = [name, quantization].filter((p) => p && p !== "");
      exportName = `SALAMANDRA_${nameParts.map(cleanPart).join("_")}`;
    } else if (
      lowerPath.includes("indictrans") ||
      lowerFilename.includes("indictrans")
    ) {
      const langMatch = filename.match(/(en-indic|indic-en)/i);
      const langDir = langMatch
        ? langMatch[1]!.toUpperCase().replace("-", "_")
        : "";
      const sizeMatch = filename.match(/(\d+[MB])/i);
      const size = sizeMatch ? sizeMatch[1]! : "";
      const nameParts = [langDir, size, quantization].filter(
        (p) => p && p !== "",
      );
      exportName = `INDICTRANS_${nameParts.map(cleanPart).join("_")}`;
    } else if (
      lowerPath.includes("opus") ||
      lowerFilename.includes("opus")
    ) {
      const langMatch = filename.match(/-([a-z]{2})-([a-z]{2})\./i);
      const langPair = langMatch
        ? `${langMatch[1]!.toUpperCase()}_${langMatch[2]!.toUpperCase()}`
        : "";
      const nameParts = [langPair, quantization].filter((p) => p && p !== "");
      exportName = `OPUS_${nameParts.map(cleanPart).join("_")}`;
    } else if (
      lowerPath.includes("bergamot") ||
      lowerFilename.includes("bergamot")
    ) {
      const langMatch = filename.match(/\.([a-z]{2})-([a-z]{2})\./i);
      const langPair = langMatch
        ? `${langMatch[1]!.toUpperCase()}_${langMatch[2]!.toUpperCase()}`
        : "";
      const nameParts = [langPair].filter((p) => p && p !== "");
      exportName = `BERGAMOT_${nameParts.map(cleanPart).join("_")}`;
    } else {
      const nameParts = [name, quantization].filter((p) => p && p !== "");
      exportName = `NMT_${nameParts.map(cleanPart).join("_")}`;
    }
  } else if (addon === "llm") {
    const nameParts = [name, quantization].filter((p) => p && p !== "");
    exportName = nameParts.map(cleanPart).join("_");
    if (filename.includes("mmproj")) {
      exportName = "MMPROJ_" + exportName;
    }
  } else if (addon === "embeddings") {
    const nameParts = [name, quantization].filter((p) => p && p !== "");
    exportName = nameParts.map(cleanPart).join("_");
  } else if (addon === "tts") {
    const nameParts = [name].filter((p) => p && p !== "");
    exportName = `TTS_${nameParts.map(cleanPart).join("_")}`;
    if (filename.includes("config.json")) {
      exportName = exportName + "_CONFIG";
    }
  } else if (addon === "ocr") {
    let fileType = "";
    if (filename.includes("detector")) {
      fileType = "DETECTOR";
    } else if (filename.includes("recognizer")) {
      fileType = "RECOGNIZER";
    }
    const nameParts = [name, fileType].filter((p) => p && p !== "");
    exportName = `OCR_${nameParts.map(cleanPart).join("_")}`;
  } else {
    exportName = cleanPart(filename.replace(/\.\w+$/, ""));
  }

  exportName = exportName.replace(/^_+|_+$/g, "").replace(/_+/g, "_");

  if (detectShardedModel(filename).isSharded) {
    exportName = `${exportName}_SHARD`;
  }

  let finalName = exportName || "UNKNOWN_MODEL";
  let counter = 1;
  while (usedNames.has(finalName)) {
    finalName = `${exportName}_${counter++}`;
  }
  usedNames.add(finalName);

  return finalName;
}

// --- Code generation ---

function generateModelsFileContent(models: ProcessedModel[]): string {
  const usedNames = new Set<string>();

  const modelsWithNames = models.map((m) => ({
    ...m,
    name: generateExportName({
      path: m.registryPath,
      engine: m.engine,
      name: m.modelName,
      quantization: m.quantization,
      usedNames,
    }),
  }));

  return generateFileContentWithNames(modelsWithNames);
}

function generateFileContentWithNames(
  modelsWithNames: (ProcessedModel & { name: string })[],
): string {
  const entries = modelsWithNames
    .map((m) => {
      const addonAlias = m.addon;
      let entry = `  {
    name: "${m.name}",
    registryPath: "${m.registryPath}",
    registrySource: "${m.registrySource}",
    blobCoreKey: "${m.blobCoreKey}",
    blobBlockOffset: ${m.blobBlockOffset},
    blobBlockLength: ${m.blobBlockLength},
    blobByteOffset: ${m.blobByteOffset},
    modelId: "${m.modelId}",
    addon: "${addonAlias}",
    expectedSize: ${m.expectedSize},
    sha256Checksum: "${m.sha256Checksum}",
    engine: "${m.engine || ""}",
    quantization: "${m.quantization || ""}",
    params: "${m.params || ""}"`;

      if (m.shardMetadata) {
        entry += `,\n    shardMetadata: ${JSON.stringify(m.shardMetadata)}`;
      }

      entry += "\n  }";
      return entry;
    })
    .join(",\n");

  const exports = modelsWithNames
    .map((m, i) => {
      return `export const ${m.name} = {
  name: "${m.name}",
  src: \`registry://\${models[${i}].registrySource}/\${models[${i}].registryPath}\`,
  registryPath: models[${i}].registryPath,
  registrySource: models[${i}].registrySource,
  blobCoreKey: models[${i}].blobCoreKey,
  blobBlockOffset: models[${i}].blobBlockOffset,
  blobBlockLength: models[${i}].blobBlockLength,
  blobByteOffset: models[${i}].blobByteOffset,
  modelId: models[${i}].modelId,
  expectedSize: models[${i}].expectedSize,
  sha256Checksum: models[${i}].sha256Checksum,
  addon: models[${i}].addon,
  engine: models[${i}].engine,
  quantization: models[${i}].quantization,
  params: models[${i}].params,
} as const;`;
    })
    .join("\n\n");

  return `// THIS FILE IS AUTO-GENERATED BY scripts/update-models.ts
// DO NOT MODIFY MANUALLY

export type RegistryItem = {
  name: string;
  registryPath: string;
  registrySource: string;
  blobCoreKey: string;
  blobBlockOffset: number;
  blobBlockLength: number;
  blobByteOffset: number;
  modelId: string;
  addon: "llm" | "whisper" | "embeddings" | "nmt" | "vad" | "tts" | "ocr" | "other";
  expectedSize: number;
  sha256Checksum: string;
  engine: string;
  quantization: string;
  params: string;
  shardMetadata?: readonly { 
    filename: string; 
    expectedSize: number; 
    sha256Checksum: string; 
    blobCoreKey: string; 
    blobBlockOffset: number;
    blobBlockLength: number;
    blobByteOffset: number;
  }[];
};

export type ModelConstant = {
  name: string;
  src: string;
  registryPath: string;
  registrySource: string;
  blobCoreKey: string;
  blobBlockOffset: number;
  blobBlockLength: number;
  blobByteOffset: number;
  modelId: string;
  expectedSize: number;
  sha256Checksum: string;
  addon: "llm" | "whisper" | "embeddings" | "nmt" | "vad" | "tts" | "ocr" | "other";
  engine: string;
  quantization: string;
  params: string;
};

export const models = [
${entries}
] as const satisfies readonly RegistryItem[];

// Individual model constants for direct import/use with loadModel
// These contain all metadata and can be used directly: loadModel({ modelSrc: WHISPER_TINY, ... })
${exports}

// Helper function to get model by name
export function getModelByName(name: string): RegistryItem | undefined {
  return models.find((model) => model.name === name);
}

// Helper function to get model by registry path
export function getModelByPath(registryPath: string): RegistryItem | undefined {
  return models.find((model) => model.registryPath === registryPath);
}

// Helper function for blob-based lookups
export function getModelBySrc(modelId: string, blobCoreKey: string): RegistryItem | undefined {
  return models.find((model) => model.modelId === modelId && model.blobCoreKey === blobCoreKey);
}
`;
}

// --- Registry processing ---

function toHexString(
  value: Buffer | string | { data: number[] } | undefined,
): string {
  if (!value) return "";
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (typeof value === "string") return value;
  if (typeof value === "object" && "data" in value) {
    return Buffer.from(value.data).toString("hex");
  }
  return "";
}

function processRegistryModel(model: QVACModelEntry): ProcessedModel {
  const filename = model.path.split("/").pop() || model.path;
  const blobBinding = model.blobBinding;

  const blobCoreKey = toHexString(blobBinding?.coreKey);
  const blobBlockOffset = blobBinding?.blockOffset ?? 0;
  const blobBlockLength = blobBinding?.blockLength ?? 0;
  const blobByteOffset = blobBinding?.byteOffset ?? 0;
  const expectedSize = blobBinding?.byteLength ?? 0;
  // The registry client types define sha256 on QVACModelEntry, but at runtime
  // the value lives on blobBinding (not reflected in types). Try both.
  const sha256Checksum =
    model.sha256 ||
    (blobBinding as unknown as Record<string, string>)?.["sha256"] ||
    "";

  const addon = getAddonFromEngine(model.engine);

  const result: ProcessedModel = {
    registryPath: model.path,
    registrySource: model.source,
    blobCoreKey,
    blobBlockOffset,
    blobBlockLength,
    blobByteOffset,
    modelId: filename,
    addon,
    expectedSize,
    sha256Checksum,
    engine: resolveCanonicalEngine(model.engine),
    modelName: extractModelName(model.path),
    quantization: model.quantization || "",
    params: model.params || "",
  };

  const shardDetection = detectShardedModel(filename);
  if (shardDetection.isSharded) {
    result.isShardPart = true;
    result.shardInfo = shardDetection;
  }

  return result;
}

function extractModelName(registryPath: string): string {
  const parts = registryPath.split("/");
  if (parts.length >= 2) {
    return parts[1] || parts[0] || "";
  }
  return (
    registryPath
      .split("/")
      .pop()
      ?.replace(/\.\w+$/, "") || ""
  );
}

// --- Shard grouping ---

function groupShardedModels(models: ProcessedModel[]): ProcessedModel[] {
  const shardGroups = new Map<string, ProcessedModel[]>();
  const nonShardedModels: ProcessedModel[] = [];

  for (const model of models) {
    if (model.isShardPart && model.shardInfo) {
      const baseKey = `${model.registrySource}:${model.shardInfo.baseFilename}`;
      if (!shardGroups.has(baseKey)) {
        shardGroups.set(baseKey, []);
      }
      shardGroups.get(baseKey)!.push(model);
    } else {
      nonShardedModels.push(model);
    }
  }

  const processedShards: ProcessedModel[] = [];
  for (const [baseKey, shards] of shardGroups) {
    shards.sort(
      (a, b) => (a.shardInfo?.currentShard ?? 0) - (b.shardInfo?.currentShard ?? 0),
    );

    const firstShard = shards[0]!;
    const totalExpectedShards = firstShard.shardInfo?.totalShards ?? 0;

    if (shards.length !== totalExpectedShards) {
      console.warn(
        `⚠️  Expected ${totalExpectedShards} shards but found ${shards.length} for ${baseKey}`,
      );
    }

    const totalSize = shards.reduce((sum, s) => sum + s.expectedSize, 0);

    const shardMetadata: ShardMetadataEntry[] = shards.map((s) => ({
      filename: s.modelId,
      expectedSize: s.expectedSize,
      sha256Checksum: s.sha256Checksum,
      blobCoreKey: s.blobCoreKey,
      blobBlockOffset: s.blobBlockOffset,
      blobBlockLength: s.blobBlockLength,
      blobByteOffset: s.blobByteOffset,
    }));

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { isShardPart: _shard, shardInfo: _info, ...rest } = firstShard;
    processedShards.push({
      ...rest,
      expectedSize: totalSize,
      shardMetadata,
    });
  }

  return [...nonShardedModels, ...processedShards];
}

// --- Collection & dedup ---

async function collectModels(
  options: CollectOptions = {},
): Promise<ProcessedModel[]> {
  const { showDuplicates = false, noDedup = false } = options;
  const models: ProcessedModel[] = [];

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const registryCoreKey: string =
    process.env["QVAC_REGISTRY_CORE_KEY"] ?? DEFAULT_REGISTRY_CORE_KEY;
  const client = new QVACRegistryClient({ registryCoreKey });

  try {
    await client.ready();

    const registryModels = await client.findModels({});

    console.log(`📦 Found ${registryModels.length} entries in registry`);

    for (const registryModel of registryModels) {
      const processed = processRegistryModel(registryModel);
      models.push(processed);
    }
  } finally {
    await client.close();
  }

  const groupedModels = groupShardedModels(models);

  if (noDedup) {
    console.log(`\n⏭️  Skipping deduplication (--no-dedup flag set)`);
    return groupedModels;
  }

  const seenChecksums = new Map<string, string>();
  const dedupedModels: ProcessedModel[] = [];
  const skipped: { name: string; checksum: string; reason: string }[] = [];

  for (const model of groupedModels) {
    if (!model.sha256Checksum || model.sha256Checksum === "") {
      dedupedModels.push(model);
      continue;
    }

    if (seenChecksums.has(model.sha256Checksum)) {
      skipped.push({
        name: model.registryPath,
        checksum: model.sha256Checksum,
        reason: `Duplicate of ${seenChecksums.get(model.sha256Checksum)}`,
      });
      continue;
    }

    seenChecksums.set(model.sha256Checksum, model.registryPath);
    dedupedModels.push(model);
  }

  if (skipped.length > 0) {
    console.log(`\n🧹 Removed ${skipped.length} duplicate model(s)`);
    if (showDuplicates) {
      skipped.forEach(({ name, checksum, reason }) => {
        console.log(`  - ${name}`);
        console.log(`    Checksum: ${checksum}`);
        console.log(`    ${reason}`);
      });
    } else {
      console.log(`   Use --show-duplicates to see details`);
    }
  }

  return dedupedModels;
}

// --- Current model loading ---

function loadCurrentModels(): CurrentModel[] {
  try {
    if (!fs.existsSync(OUTPUT_FILE)) {
      return [];
    }

    const content = fs.readFileSync(OUTPUT_FILE, "utf-8");
    const modelsMatch = content.match(
      /export const models = \[([\s\S]*?)\] as const/,
    );

    if (!modelsMatch?.[1]) {
      return [];
    }

    const modelsArrayContent = modelsMatch[1];
    const currentModels: CurrentModel[] = [];

    const modelRegex =
      /\{[^}]+name:\s*"([^"]+)"[^}]+(?:registryPath|hyperbeeKey):\s*"([^"]+)"[^}]+\}/g;
    let match;

    while ((match = modelRegex.exec(modelsArrayContent)) !== null) {
      if (match[1] && match[2]) {
        currentModels.push({
          name: match[1],
          registryPath: match[2],
        });
      }
    }

    return currentModels;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.warn("⚠️  Could not load current models:", message);
    return [];
  }
}

// --- Utilities ---

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function getCommitHash(short = false): string {
  try {
    const cmd = short ? "git rev-parse --short HEAD" : "git rev-parse HEAD";
    return execSync(cmd, { encoding: "utf-8" }).trim();
  } catch (error) {
    throw new Error("Git is required to generate history file", {
      cause: error,
    });
  }
}

// --- History ---

function createHistoryFile(
  added: (ProcessedModel & { name: string })[],
  removed: CurrentModel[],
  currentModels: CurrentModel[],
): string | null {
  if (added.length === 0 && removed.length === 0) {
    return null;
  }

  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }

  const shortHash = getCommitHash(true);
  const fullHash = getCommitHash(false);
  const timestamp = new Date().toISOString();
  const filename = `${shortHash}.txt`;
  const filepath = `${HISTORY_DIR}/${filename}`;

  let content = `commit=${fullHash}\n`;
  content += `timestamp=${timestamp}\n`;
  content += `previous_count=${currentModels.length}\n`;
  content += `new_count=${currentModels.length + added.length - removed.length}\n`;
  content += `\n`;

  if (added.length > 0) {
    content += `[added]\n`;
    added.forEach((m) => {
      content += `${m.name}\n`;
    });
    content += `\n`;
  }

  if (removed.length > 0) {
    content += `[removed]\n`;
    removed.forEach((m) => {
      content += `${m.name}\n`;
    });
  }

  fs.writeFileSync(filepath, content);
  return filepath;
}

// --- Comparison ---

function compareModels(
  remoteModels: ProcessedModel[],
  currentModels: CurrentModel[],
): { added: ProcessedModel[]; removed: CurrentModel[] } {
  const currentPaths = new Set(currentModels.map((m) => m.registryPath));
  const remotePaths = new Set(remoteModels.map((m) => m.registryPath));

  const added = remoteModels.filter((m) => !currentPaths.has(m.registryPath));
  const removed = currentModels.filter(
    (m) => !remotePaths.has(m.registryPath),
  );

  return { added, removed };
}

// --- Commands ---

async function checkOnly(
  nonBlocking = false,
  showDuplicates = false,
): Promise<void> {
  const timeoutMs = 30000;
  let timedOut = false;

  const timeoutPromise = new Promise<null>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      console.log("⏱️  Model check timed out");
      console.log("   Run 'bun check-models' manually to retry");
      resolve(null);
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      (async () => {
        const remoteModels = await collectModels({ showDuplicates });
        const currentModels = loadCurrentModels();

        remoteModels.sort(
          (a, b) =>
            a.addon.localeCompare(b.addon) ||
            a.registryPath.localeCompare(b.registryPath),
        );

        return { remoteModels, currentModels };
      })(),
      timeoutPromise,
    ]);

    if (timedOut || !result) {
      process.exit(nonBlocking ? 0 : 1);
    }

    const { remoteModels, currentModels } = result;
    const { added, removed } = compareModels(remoteModels, currentModels);

    if (added.length === 0 && removed.length === 0) {
      console.log(`✅ Models are up to date (${remoteModels.length} models)`);
      process.exit(0);
    }

    console.log("");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    if (added.length > 0) {
      console.log(
        `✨ ${added.length} new model${added.length === 1 ? "" : "s"} available:`,
      );
      const usedNames = new Set<string>();
      added.slice(0, 10).forEach((m) => {
        const exportName = generateExportName({
          path: m.registryPath,
          engine: m.engine,
          name: m.modelName,
          quantization: m.quantization,
          usedNames,
        });
        console.log(
          `  + ${exportName} (${m.addon}, ${formatSize(m.expectedSize)})`,
        );
      });
      if (added.length > 10) {
        console.log(`  ... and ${added.length - 10} more`);
      }
    }

    if (removed.length > 0) {
      console.log(
        `\n⚠️  ${removed.length} model${removed.length === 1 ? "" : "s"} removed:`,
      );
      removed.slice(0, 5).forEach((m) => {
        console.log(`  - ${m.name}`);
      });
      if (removed.length > 5) {
        console.log(`  ... and ${removed.length - 5} more`);
      }
    }

    console.log("");
    console.log(`💡 Run 'bun update-models' to sync changes`);
    console.log("");
    if (nonBlocking) {
      console.log("💡 Commit will proceed - update models when ready");
    }
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");

    process.exit(nonBlocking ? 0 : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Model check failed:", message);
    process.exit(nonBlocking ? 0 : 1);
  }
}

async function updateModels(
  showDuplicates = false,
  noDedup = false,
): Promise<void> {
  console.log("🔄 Fetching models from QVAC Registry...\n");

  const currentModels = loadCurrentModels();

  const models = await collectModels({ showDuplicates, noDedup });

  const { added, removed } = compareModels(models, currentModels);

  models.sort(
    (a, b) =>
      a.addon.localeCompare(b.addon) ||
      a.registryPath.localeCompare(b.registryPath),
  );

  fs.writeFileSync(OUTPUT_FILE, generateModelsFileContent(models));

  try {
    execSync(`npx prettier --write "${OUTPUT_FILE}"`, { stdio: "pipe" });
  } catch {
    // prettier not available, skip formatting
  }

  console.log(`✅ Generated ${models.length} models → ${OUTPUT_FILE}`);

  const usedNamesForHistory = new Set<string>();
  const addedWithNames = added.map((m) => ({
    ...m,
    name: generateExportName({
      path: m.registryPath,
      engine: m.engine,
      name: m.modelName,
      quantization: m.quantization,
      usedNames: usedNamesForHistory,
    }),
  }));

  if (added.length > 0 || removed.length > 0) {
    const historyFile = createHistoryFile(
      addedWithNames,
      removed,
      currentModels,
    );
    if (historyFile) {
      console.log(`📜 Created history file → ${historyFile}`);
      console.log(`   Added: ${added.length}, Removed: ${removed.length}`);
    }
  }
}

// --- Main ---

async function main(): Promise<void> {
  const CHECK_ONLY = process.argv.includes("--check");
  const NON_BLOCKING = process.argv.includes("--non-blocking");
  const SHOW_DUPLICATES = process.argv.includes("--show-duplicates");
  const NO_DEDUP = process.argv.includes("--no-dedup");

  if (CHECK_ONLY) {
    await checkOnly(NON_BLOCKING, SHOW_DUPLICATES);
  } else {
    await updateModels(SHOW_DUPLICATES, NO_DEDUP);
  }
}

main().catch(console.error);
