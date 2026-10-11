#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_build="$task_root/.tools/media-build"
task_prefix="$task_build/prefix"
mkdir -p "$task_build/downloads" "$task_build/src" "$task_prefix" "$task_build/output"
python3 - "$task_root" "$task_build" <<'PY'
import sys,json,urllib.request,hashlib,pathlib,tarfile
root,build=map(pathlib.Path,sys.argv[1:])
config=json.loads((root/'tools/media-build.json').read_text())
for name,item in config['archives'].items():
    suffix='.tar.xz' if name in ('llvm','nasm') else '.tar.gz'
    archive=build/'downloads'/(name+suffix)
    if not archive.exists():
        with urllib.request.urlopen(item['url'],timeout=120) as response: archive.write_bytes(response.read())
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=item['sha256']: raise SystemExit('Archive checksum mismatch: '+name)
    directory=build/'src'/name
    if not directory.exists():
        directory.mkdir()
        with tarfile.open(archive) as source:
            # Immutable official source archives; retain files only inside the target.
            source.extractall(directory,filter='data')
    print('Verified '+name)
PY
task_llvm="$(find "$task_build/src/llvm" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
task_ffmpeg="$(find "$task_build/src/ffmpeg" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
task_openh264="$(find "$task_build/src/openh264" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
task_nasm="$(find "$task_build/src/nasm" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
export PATH="$task_build/host/bin:$task_llvm/bin:$PATH"
if [ ! -x "$task_build/host/bin/nasm" ]; then
  (cd "$task_nasm" && ./configure --prefix="$task_build/host" && make -j2 && make install)
fi
make -C "$task_openh264" -j2 OS=mingw_nt ARCH=x86_64 CC=x86_64-w64-mingw32-clang CXX=x86_64-w64-mingw32-clang++ AR=llvm-ar PREFIX="$task_prefix" install-static
export PKG_CONFIG_PATH="$task_prefix/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$task_prefix/lib/pkgconfig"
cd "$task_ffmpeg"
./configure \
  --prefix="$task_prefix" --arch=x86_64 --target-os=mingw32 --enable-cross-compile \
  --cross-prefix=x86_64-w64-mingw32- --cc=x86_64-w64-mingw32-clang --cxx=x86_64-w64-mingw32-clang++ \
  --ld=x86_64-w64-mingw32-clang --ar=llvm-ar --nm=llvm-nm --ranlib=llvm-ranlib \
  --disable-autodetect --enable-libopenh264 --enable-shared --disable-static \
  --enable-version3 --disable-gpl --disable-nonfree --disable-doc --disable-debug \
  --disable-network --disable-ffplay --pkg-config=pkg-config --pkg-config-flags=--static \
  --extra-cflags="-I$task_prefix/include" --extra-ldflags="-L$task_prefix/lib -static" \
  --extra-libs=-lstdc++ --extra-version=mawjivo
make -j2
make install
python3 - "$task_root" "$task_build" "$task_ffmpeg" "$task_openh264" "$task_llvm" <<'PY'
import sys,pathlib,json,hashlib,zipfile,shutil,subprocess
root,build,ffmpeg,openh264,llvm=map(pathlib.Path,sys.argv[1:])
package=build/'package'/'ffmpeg-mawjivo-win64'
(package/'bin').mkdir(parents=True,exist_ok=True)
for file in (build/'prefix'/'bin').iterdir():
    if file.suffix in ('.exe','.dll'): shutil.copy(file,package/'bin'/file.name)
shutil.copy(ffmpeg/'COPYING.LGPLv3',package/'LICENSE.txt')
licenses=package/'licenses';licenses.mkdir(exist_ok=True)
shutil.copy(openh264/'LICENSE',licenses/'OpenH264.txt')
for file in llvm.rglob('*'):
    if file.is_file() and any(word in file.name.upper() for word in ('LICENSE','COPYING','NOTICE')):
        dest=licenses/'llvm-runtime'/file.relative_to(llvm);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy(file,dest)
config=json.loads((root/'tools/media-build.json').read_text())
(package/'SOURCES.json').write_text(json.dumps(config,indent=2)+'\n')
# A release must contain no accidental external runtime DLL dependencies.
owned={p.name.lower() for p in (package/'bin').iterdir()}
imports=set()
for file in (package/'bin').iterdir():
    dump=subprocess.check_output([str(llvm/'bin/llvm-objdump'),'-p',str(file)],text=True)
    for line in dump.splitlines():
        if 'DLL Name:' in line: imports.add(line.split('DLL Name:')[1].strip().lower())
(build/'output/imports.json').write_text(json.dumps(sorted(imports),indent=2))
unexpected=[name for name in imports if name not in owned and name.startswith(('libc++','libunwind','libwinpthread','libgcc','libstdc++'))]
if unexpected: raise SystemExit('Unexpected toolchain runtime DLL: '+','.join(unexpected))
binary=build/'output/media-tools-win32-x64.zip'
with zipfile.ZipFile(binary,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as output:
    for file in package.rglob('*'):
        if file.is_file(): output.write(file,file.relative_to(package.parent))
sources=build/'output/media-tools-sources.zip'
with zipfile.ZipFile(sources,'w',zipfile.ZIP_STORED) as output:
    for file in (build/'downloads').iterdir(): output.write(file,'archives/'+file.name)
    for name in ('tools/media-build.json','scripts/build-media-tools.sh'):output.write(root/name,name)
    output.write(ffmpeg/'ffbuild/config.mak','ffmpeg-config.mak')
    output.writestr('changes.diff','')
    output.writestr('README.txt','Unmodified FFmpeg and OpenH264 source archives, verified compiler and NASM, and the exact build recipe. Run scripts/build-media-tools.sh on Ubuntu 24.04 with Python 3.12, GNU make, pkg-config and standard build utilities. FFmpeg uses LGPL-3.0-or-later shared DLLs. OpenH264 uses BSD-2-Clause. No GPL or nonfree library is enabled.\n')
digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
manifest={'schemaVersion':1,'version':config['ffmpegVersion'],'license':'LGPL-3.0-or-later','upstream':'https://ffmpeg.org/','sourceCommit':config['ffmpegCommit'],'builderSource':'scripts/build-media-tools.sh','licenseSha256':digest(package/'LICENSE.txt'),'sources':{'file':sources.name,'sha256':digest(sources),'bytes':sources.stat().st_size},'platforms':{'win32-x64':{'archiveRoot':package.name,'sha256':digest(binary),'files':{p.name:digest(p) for p in (package/'bin').iterdir()}}}}
(build/'output/manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'binaryBytes':binary.stat().st_size,'sourceBytes':sources.stat().st_size,'components':len(owned),'licenses':len(list(licenses.rglob('*')))}))
PY
