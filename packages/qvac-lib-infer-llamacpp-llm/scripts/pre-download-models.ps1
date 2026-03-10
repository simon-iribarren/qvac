# Pre-download GGUF models for integration tests (Windows).
# Run before tests in CI to avoid download timeouts.
$ErrorActionPreference = "Stop"
$ModelDir = Join-Path $PSScriptRoot ".." "test" "model"
New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null
Set-Location $ModelDir

function Download-IfMissing {
    param([string]$Name, [string]$Url)
    if (Test-Path $Name) {
        Write-Host "✓ $Name already present"
        return
    }
    Write-Host "Downloading $Name..."
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Name -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 3600
    } catch {
        Write-Error "Failed to download $Name : $_"
        throw
    }
    $size = (Get-Item $Name).Length / 1MB
    Write-Host "✓ $Name ready ($([math]::Round($size, 1)) MB)"
}

Download-IfMissing "Qwen3-0.6B-Q8_0.gguf" "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf"
Download-IfMissing "Llama-3.2-1B-Instruct-Q4_0.gguf" "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf"
Download-IfMissing "AfriqueGemma-4B.Q4_K_M.gguf" "https://huggingface.co/mradermacher/AfriqueGemma-4B-GGUF/resolve/main/AfriqueGemma-4B.Q4_K_M.gguf"
Download-IfMissing "dolphin-mixtral-2x7b-dop-Q2_K.gguf" "https://huggingface.co/jmb95/laser-dolphin-mixtral-2x7b-dpo-GGUF/resolve/main/dolphin-mixtral-2x7b-dop-Q2_K.gguf"
Download-IfMissing "SmolVLM2-500M-Video-Instruct-Q8_0.gguf" "https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/SmolVLM2-500M-Video-Instruct-Q8_0.gguf"
Download-IfMissing "mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf" "https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf"

Write-Host ""
Write-Host "Model pre-download complete."
