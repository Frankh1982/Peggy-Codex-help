Param(
  [string]$EnvPath = ".env"
)

if (-Not (Test-Path $EnvPath)) {
  Write-Host "Creating $EnvPath from .env.example"
  Copy-Item -Path ".env.example" -Destination $EnvPath
}

npm install
npm run capsule
npm run dev
