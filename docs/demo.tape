Output docs/assets/demo.gif

Require node

Set Shell "zsh"
Set Width 1200
Set Height 700
Set FontSize 19
Set FontFamily "Menlo"
Set LetterSpacing 0
Set LineHeight 1.1
Set Framerate 25
Set PlaybackSpeed 1
Set Theme "Catppuccin Mocha"
Set MarginFill "#11111b"
Set Margin 0
Set Padding 24
Set WindowBar "ColorfulRight"
Set WindowBarSize 34
Set TypingSpeed 10ms

# The hidden command launches a deterministic replay; no live model call is made.
Hide
Type "node docs/demo-replay.mjs"
Enter
Show

# Keep the capture to README length. The replay remains alive so no shell prompt
# appears before VHS finishes recording.
Sleep 24s
