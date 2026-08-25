
Cloud


















# List every player who needs a profile file (one per line, comma-separated)
$players = @(
    "Adam Butcher",
    "Aidan Garratt",
    "Aidan Wood",
    "Alb Jarman",
    "Barney Chaudhry",
    "Ben O'Callaghan",
    "Cian Hughes",
    "Dan Campbell",
    "Dan Wells",
    "Danny Hartland",
    "Harry Beale",
    "Henry Lupton",
    "Jack Kelly",
    "Jack McKnight",
    "Jack Newton",
    "Jack Stoddard",
    "Jack Warby",
    "Jake Morrison",
    "Jake O'Neill",
    "James Beer",
    "James Henderson",
    "James Wood",
    "Jayden Comer",
    "Joe Hopkins",
    "Joel Keaney",
    "Joseph D'Ambrosio",
    "Lewis Forrest",
    "Liam English",
    "Louis Healy",
    "Louis Woods-Kelly",
    "Luke Davies",
    "Luke Egan",
    "Matt Duke",
    "Matt Watts",
    "Max Halder",
    "Max Leeves",
    "Michael Davy",
    "Mikey Guinness",
    "Nathan Miller",
    "Oli Makin",
    "Oli Graham",
    "Oliver Nunn",
    "Ruben Parker",
    "Rufus Eden",
    "Sam Oddy",
    "Sam Staveley",
    "Sam Tookey",
    "Sam Wilkins",
    "Seamus Grant",
    "Tom Graham",
    "Tom Halliday",
    "Toby Williams",
    "Tom Sibley",
    "Tommy Watson",
    "Will Wells",
    "Will Brice"
)
 
# Folder the files get created in - run this script from your project root (uosdarts)
$outputDir = "data\players"
 
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}
 
foreach ($name in $players) {
    $slug = $name.ToLower() -replace "[^a-z0-9\s-]", "" -replace "\s+", "-"
    $filePath = Join-Path $outputDir "$slug.yaml"
 
    if (Test-Path $filePath) {
        Write-Host "Skipping $name - $filePath already exists"
        continue
    }
 
    $content = @"
nickname: "INSERT"
year: "INSERT"
image: "images/players/$slug.jpg"
national_champion: 0
stage_winner: 0
pc_best: 'N/A'
pc_wins: 0
major_best: 'N/A'
major_wins: 0
"@
 
    Set-Content -Path $filePath -Value $content -Encoding UTF8
    Write-Host "Created $filePath"
}
 
Write-Host ""
Write-Host "Done. $($players.Count) players processed."
 

