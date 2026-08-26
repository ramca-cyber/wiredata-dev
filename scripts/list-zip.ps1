Add-Type -Assembly System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead('release/wiredata-extension-v0.1.5.zip')
$z.Entries.FullName | Sort-Object
$z.Dispose()
