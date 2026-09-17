param($ws, $root, $pkg, $base, $head)
$log = git -C $root log --oneline $base..$head | Out-String
$stat = git -C $root diff --stat $base $head | Out-String
$diff = git -C $root diff -U10 $base $head | Out-String
$fence = '```'
$content = "# Review package - $base..$head`n`n## Commits`n$fence$log$fence`n`n## Stat`n$fence$stat$fence`n`n## Full diff (-U10)`n$fence$diff$fence"
Set-Content -Path $pkg -Value $content -Encoding UTF8
Write-Output "package: $([math]::Round((Get-Item $pkg).Length/1KB,1)) KB"
