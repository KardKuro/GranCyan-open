# Grancyan APK 构建脚本（无需 Gradle / Android Studio，直接用 SDK 命令行工具）
# 用法：双击 build.bat，或 powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'

$root      = $PSScriptRoot                      # .../GranCyan2.0/android
$proj      = Split-Path $root -Parent           # .../GranCyan2.0
$sdk       = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT }
             elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME }
             else { "$env:LOCALAPPDATA\Android\Sdk" }
$buildTools = "$sdk\build-tools\36.1.0"
$androidJar = "$sdk\platforms\android-36\android.jar"
$aapt2     = "$buildTools\aapt2.exe"
$zipalign  = "$buildTools\zipalign.exe"
$apksigner = "$buildTools\apksigner.bat"
$build     = "$root\build"

# JDK：很多机器上 javac 根本不在 PATH 里，
# 裸调 javac/jar 会在第 4 步 CommandNotFoundException 挂掉。自己找一个，别指望 PATH。
# 优先 JAVA_HOME → PATH → Android Studio 自带的 JBR（跟 SDK 配套，最稳）→ 其他常见位置。
function Resolve-Jdk {
    if ($env:JAVA_HOME -and (Test-Path "$env:JAVA_HOME\bin\javac.exe")) { return $env:JAVA_HOME }
    $onPath = Get-Command javac.exe -ErrorAction SilentlyContinue
    if ($onPath) { return (Split-Path (Split-Path $onPath.Source -Parent) -Parent) }
    $guesses = @(
        'C:\Program Files\Android\Android Studio\jbr',
        "$env:LOCALAPPDATA\Programs\Android Studio\jbr"
    )
    foreach ($g in $guesses) {
        if (Test-Path "$g\bin\javac.exe") { return $g }
        if (Test-Path "$g\javac.exe")     { return (Split-Path $g -Parent) }   # bin 目录直给的情况
    }
    return $null
}
$jdk = Resolve-Jdk
if (-not $jdk) {
    throw "找不到 JDK（javac.exe）。装一个 JDK 17+ 并设 JAVA_HOME，或把路径加进上面的 Resolve-Jdk 候选列表。"
}
$javac = if (Test-Path "$jdk\bin\javac.exe") { "$jdk\bin\javac.exe" } else { "$jdk\javac.exe" }
$jarExe = if (Test-Path "$jdk\bin\jar.exe")  { "$jdk\bin\jar.exe" }  else { "$jdk\jar.exe" }
$env:JAVA_HOME = $jdk   # apksigner.bat 靠它找 java

Write-Host "=== Grancyan APK build ===" -ForegroundColor Cyan
Write-Host ("     JDK: {0}" -f $jdk) -ForegroundColor DarkGray

# 0. 清理并准备目录
if (Test-Path $build) { Remove-Item -Recurse -Force $build }
New-Item -ItemType Directory -Force "$build\classes","$build\dex" | Out-Null
New-Item -ItemType Directory -Force "$root\assets" | Out-Null

# 1. 同步前端资源到 assets
Copy-Item "$proj\index.html"  "$root\assets\index.html" -Force
Copy-Item "$proj\output.css"  "$root\assets\output.css" -Force

# index.html 只是骨架，样式和逻辑在 css/ 和 js/ 里；漏拷 = APK 白屏。img/ 是从 base64 里抽出来的图
foreach ($d in @('css', 'js', 'img')) {
    $dst = "$root\assets\$d"
    if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
    New-Item -ItemType Directory -Force $dst | Out-Null
    Copy-Item "$proj\$d\*" $dst -Recurse -Force
}

# 1.5 内置表情包：复制 stickers/ 并生成完整 manifest（与 server.js /api/stickers 输出一致）
$stkSrc = "$proj\stickers"
$stkDst = "$root\assets\stickers"
if (Test-Path $stkDst) { Remove-Item -Recurse -Force $stkDst }
if (Test-Path $stkSrc) {
    New-Item -ItemType Directory -Force $stkDst | Out-Null
    Copy-Item "$stkSrc\*" $stkDst -Recurse -Force
    $manifest = @()
    if (Test-Path "$stkSrc\manifest.json") {
        $parsed = Get-Content "$stkSrc\manifest.json" -Raw -Encoding UTF8 | ConvertFrom-Json
        $manifest = @($parsed | ForEach-Object { $_ })   # PS5.1: 展开 ConvertFrom-Json 返回的整包数组
    }
    $known = @($manifest | ForEach-Object { $_.file })
    $extra = @(Get-ChildItem $stkSrc -File | Where-Object {
        $_.Extension -match '^\.(png|jpe?g|gif|webp|svg)$' -and $known -notcontains $_.Name
    } | ForEach-Object {
        $base = [IO.Path]::GetFileNameWithoutExtension($_.Name)
        # stickers/ 里的图整个算「自带表情库」（custom=$false），和 server.js /api/stickers 一致。
        # App 里上传的收藏走 stickers-fav/，不打进 APK。
        [pscustomobject]@{ name = $base; desc = $base; emoji = [char]::ConvertFromUtf32(0x1F5BC); file = $_.Name; custom = $false }
    })
    $json = ConvertTo-Json @($manifest + $extra) -Depth 5
    [IO.File]::WriteAllText("$stkDst\manifest.json", $json, (New-Object Text.UTF8Encoding($false)))
    Write-Host ("[1/6] assets 已同步 (index.html + output.css + {0} 个内置表情)" -f ($manifest.Count + $extra.Count))
} else {
    Write-Host "[1/6] assets 已同步 (index.html + output.css)；未找到 stickers/ 目录，跳过内置表情"
}

# 1.6 表情包分组：stickers-packs/<id>/ 一个文件夹一栏（文件夹里放图 + 可选的 pack.json）。
# 整个目录拷进 assets，再生成一份 packs.json 快照给离线的手机用。
# 清单交给 node 生成而不是 ConvertTo-Json：PS 5.1 会把只有一个元素的数组序列化成对象而不是数组，
# 只有一个包时 —— 前端拿到的不是数组，整栏在 APK 里静默消失，电脑上却一切正常。
# 顺带扫描规则和 server.js 共用一个模块，两边不会漂。
$pkSrc = "$proj\stickers-packs"
$pkDst = "$root\assets\stickers-packs"
if (Test-Path $pkDst) { Remove-Item -Recurse -Force $pkDst }
if (Test-Path $pkSrc) {
    New-Item -ItemType Directory -Force $pkDst | Out-Null
    Copy-Item "$pkSrc\*" $pkDst -Recurse -Force
    $genOut = & node "$proj\scripts\sticker-packs.js" $pkSrc "$pkDst\packs.json"
    if ($LASTEXITCODE -ne 0) { throw "生成 packs.json 失败: $genOut" }
    Write-Host ("[1/6] 表情分组已打包 ({0})" -f $genOut)
} else {
    Write-Host "[1/6] 未找到 stickers-packs/ 目录，跳过表情分组"
}

# 2. 生成各分辨率图标（源图标变化时删除 res\mipmap-* 目录可重新生成）
$iconSrc = "$proj\Grancyan应用图标.png"
$densities = @{ 'mdpi'=48; 'hdpi'=72; 'xhdpi'=96; 'xxhdpi'=144; 'xxxhdpi'=192 }
if (-not (Test-Path "$root\res\mipmap-xxxhdpi\ic_launcher.png")) {
    Add-Type -AssemblyName System.Drawing
    $srcImg = [System.Drawing.Image]::FromFile($iconSrc)
    foreach ($d in $densities.GetEnumerator()) {
        $dir = "$root\res\mipmap-$($d.Key)"
        New-Item -ItemType Directory -Force $dir | Out-Null
        $size = $d.Value
        $bmp = New-Object System.Drawing.Bitmap($size, $size)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.DrawImage($srcImg, 0, 0, $size, $size)
        $g.Dispose()
        $bmp.Save("$dir\ic_launcher.png", [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
    }
    $srcImg.Dispose()
    Write-Host "[2/6] 图标已生成 (48~192px)"
} else {
    Write-Host "[2/6] 图标已存在，跳过"
}

# 3. 编译资源 + 打包（manifest、res、assets）
& $aapt2 compile --dir "$root\res" -o "$build\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile 失败" }
# 注意：不能用 aapt2 的 -A 加 assets——Windows 上子目录会打成反斜杠路径（assets/stickers\x.png），
# Android 的 AssetManager 找不到。assets 在第 5 步用 jar 添加（jar 保证正斜杠）。
& $aapt2 link -o "$build\app-unsigned.apk" -I $androidJar `
    --manifest "$root\AndroidManifest.xml" `
    --min-sdk-version 24 --target-sdk-version 34 "$build\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 link 失败" }
Write-Host "[3/6] 资源打包完成"

# 4. 编译 Java -> dex
$nanoJar = "$root\libs\nanohttpd-2.3.1.jar"
$classpath = "$androidJar;$nanoJar"
# 源文件用扫描而不是写死清单：以前漏加新文件（BandBridge.java）时，
# javac 靠 sourcepath 碰运气解析，改动大了就编译失败或编出旧类。
$javaSrc = @(Get-ChildItem "$root\src" -Recurse -Filter *.java | ForEach-Object { $_.FullName })
Write-Host ("     Java 源文件 {0} 个" -f $javaSrc.Count) -ForegroundColor DarkGray
& $javac --release 17 -Xlint:-options -cp $classpath -d "$build\classes" @javaSrc
if ($LASTEXITCODE -ne 0) { throw "javac 失败" }
$classFiles = Get-ChildItem "$build\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& "$buildTools\d8.bat" --release --min-api 24 --lib $androidJar --classpath $nanoJar --output "$build\dex" @classFiles $nanoJar
if ($LASTEXITCODE -ne 0) { throw "d8 失败" }
Write-Host "[4/6] Java 编译 + dex 完成"

# 5. 把 classes.dex 和 assets 塞进 APK，然后对齐
Push-Location "$build\dex"
& $jarExe -uf "$build\app-unsigned.apk" classes.dex
Pop-Location
if ($LASTEXITCODE -ne 0) { throw "jar 添加 dex 失败" }
Push-Location $root
& $jarExe -uf "$build\app-unsigned.apk" assets
Pop-Location
if ($LASTEXITCODE -ne 0) { throw "jar 添加 assets 失败" }
& $zipalign -f 4 "$build\app-unsigned.apk" "$build\app-aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign 失败" }
Write-Host "[5/6] APK 对齐完成"

# 6. 签名（首次自动生成 keystore，之后复用同一个，保证可以覆盖升级安装）
$keystore = "$root\grancyan.keystore"
# 密码不写死在脚本里。来源按顺序：环境变量 GRANCYAN_KEYSTORE_PASS → android\keystore.pass
# → 都没有且 keystore 也还没生成时，随机生成一个写进 keystore.pass（已在 .gitignore 里）。
# keystore 和 keystore.pass 要一起备份：丢了任何一个，APK 都不能原地升级。
$passFile = "$root\keystore.pass"
if ($env:GRANCYAN_KEYSTORE_PASS) {
    $ksPass = $env:GRANCYAN_KEYSTORE_PASS
} elseif (Test-Path $passFile) {
    $ksPass = ([System.IO.File]::ReadAllText($passFile)).Trim()
} elseif (-not (Test-Path $keystore)) {
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $ksPass = [Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', ''
    [System.IO.File]::WriteAllText($passFile, $ksPass)
    Write-Host "      已生成随机签名密码: android\keystore.pass（不进版本库，和 keystore 一起备份）"
} else {
    throw "grancyan.keystore 已存在，但找不到它的密码：设环境变量 GRANCYAN_KEYSTORE_PASS，或把密码写进 android\keystore.pass"
}
if (-not $ksPass) { throw "签名密码是空的（检查 GRANCYAN_KEYSTORE_PASS 或 android\keystore.pass）" }
# 经环境变量交给 keytool / apksigner，密码不出现在命令行（进程列表里看不到）
$env:GRANCYAN_KS_PASS_INTERNAL = $ksPass
if (-not (Test-Path $keystore)) {
    & "$jdk\bin\keytool.exe" -genkeypair -keystore $keystore -alias grancyan -keyalg RSA -keysize 2048 `
        -validity 10000 -storepass:env GRANCYAN_KS_PASS_INTERNAL -keypass:env GRANCYAN_KS_PASS_INTERNAL `
        -dname "CN=Grancyan, OU=Grancyan, O=Grancyan, C=CN"
    if ($LASTEXITCODE -ne 0) { throw "keytool 生成密钥失败" }
    Write-Host "      新密钥已生成: grancyan.keystore（请勿删除，否则无法覆盖安装升级）"
}
& $apksigner sign --ks $keystore --ks-pass env:GRANCYAN_KS_PASS_INTERNAL `
    --out "$proj\Grancyan.apk" "$build\app-aligned.apk"
Remove-Item Env:\GRANCYAN_KS_PASS_INTERNAL -ErrorAction SilentlyContinue
if ($LASTEXITCODE -ne 0) { throw "apksigner 签名失败" }

$size = [math]::Round((Get-Item "$proj\Grancyan.apk").Length / 1MB, 2)
Write-Host "[6/6] 完成！" -ForegroundColor Green
Write-Host ("输出: {0}\Grancyan.apk ({1} MB)" -f $proj, $size) -ForegroundColor Green
