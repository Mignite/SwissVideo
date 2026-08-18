import struct, zlib, os

temp = os.environ['TEMP']
sizes = [256, 64, 48, 32, 16]
png_data = {}

for s in sizes:
    path = os.path.join(temp, f'icon_{s}.png')
    with open(path, 'rb') as f:
        raw = f.read()
    png_data[s] = raw

# ICO header: reserved(2) + type(2) + count(2)
ico = struct.pack('<HHH', 0, 1, len(sizes))

offset = 6 + len(sizes) * 16  # header + directory entries

for s in sizes:
    data = png_data[s]
    # directory entry: w,h,colors,reserved,planes,bpp,size,offset
    w = s if s < 256 else 0
    h = s if s < 256 else 0
    ico += struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(data), offset)
    offset += len(data)

for s in sizes:
    ico += png_data[s]

out = os.path.join(temp, 'icon.ico')
with open(out, 'wb') as f:
    f.write(ico)
print(f'Created {out} ({len(ico)} bytes)')
