#!/usr/bin/env sh
# Generates small synthetic test videos with ffmpeg into test/fixtures (gitignored).
set -e
cd "$(dirname "$0")/fixtures" 2>/dev/null || { mkdir -p "$(dirname "$0")/fixtures"; cd "$(dirname "$0")/fixtures"; }
noise="noise=alls=8:allf=t"
ffmpeg -v error -y -f lavfi -i "testsrc2=size=1920x1080:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 12 -vf "$noise" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart landscape-1080p30.mp4
ffmpeg -v error -y -f lavfi -i "testsrc2=size=1280x720:rate=60" -f lavfi -i "sine=frequency=330:sample_rate=44100" -t 5 -vf "$noise" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 128k gameplay-720p60.mp4
ffmpeg -v error -y -f lavfi -i "testsrc2=size=1920x1080:rate=30" -t 5 -vf "$noise" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -an tmp-land.mp4
ffmpeg -v error -y -display_rotation 90 -i tmp-land.mp4 -c copy rotated90-noaudio.mp4 && rm tmp-land.mp4
ffmpeg -v error -y -f lavfi -i "testsrc2=size=720x1280:rate=30" -f lavfi -i "sine=frequency=220:sample_rate=48000" -t 6 -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 96k portrait-720x1280.mov
ffmpeg -v error -y -f lavfi -i "testsrc2=size=1280x720:rate=30" -f lavfi -i "sine=frequency=550:sample_rate=48000" -t 6 -c:v libvpx-vp9 -b:v 2M -deadline realtime -cpu-used 8 -c:a libopus -b:a 96k vp9-720p.webm
ls -la
