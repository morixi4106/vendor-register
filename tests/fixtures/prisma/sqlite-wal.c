#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef unsigned char u8;
typedef uint32_t u32;
typedef int64_t i64;
typedef struct { int szPage; } WalIndexHdr;
typedef struct { WalIndexHdr hdr; void *pWalFd; } Wal;
#define SQLITE_PRIVATE static
#define WAL_FRAME_HDRSIZE 24
#define testcase(x) ((void)(x))

static int read_size, read_result, read_calls;
static i64 read_offset;
static i64 walFrameOffset(u32 frame, int size) {
  return 32 + ((i64)frame - 1) * (size + WAL_FRAME_HDRSIZE);
}
static int sqlite3OsRead(void *file, void *output, int size, i64 offset) {
  if (file != &read_calls || size != read_size || offset != read_offset) return -1;
  ++read_calls;
  if (read_result == 0) memset(output, 0x3c, (size_t)size);
  if (read_result == 522) memset(output, 0, (size_t)size);
  return read_result;
}

/* Insert the two byte-bound real functions; only their symbol names differ. */
@ORIGINAL_FUNCTION@
@FIXED_FUNCTION@

static int run_case(int size, int output_size, int result, int fixed) {
  u8 buffer[131074];
  Wal wal;
  int index, status;
  memset(buffer, 0xa5, sizeof(buffer));
  wal.hdr.szPage = size == 65536 ? 1 : size;
  wal.pWalFd = &read_calls;
  read_size = output_size > size ? size : output_size;
  read_offset = walFrameOffset(3, size) + WAL_FRAME_HDRSIZE;
  read_result = result;
  read_calls = 0;
  status = fixed ? fixedWalReadFrame(&wal, 3, output_size, buffer + 1)
                 : originalWalReadFrame(&wal, 3, output_size, buffer + 1);
  if (status != result || read_calls != 1 || buffer[0] != 0xa5) return 1;
  for (index = 0; index < read_size; ++index) {
    int expected = result == 0 ? 0x3c : result == 522 ? 0 : 0xa5;
    if (buffer[index + 1] != expected) return 2;
  }
  for (index = read_size; index < output_size; ++index)
    if (buffer[index + 1] != (fixed ? 0 : 0xa5)) return 3;
  for (index = output_size + 1; index < (int)sizeof(buffer); ++index)
    if (buffer[index] != 0xa5) return 4;
  return 0;
}

int main(void) {
  const int sizes[] = {512, 1024, 2048, 4096, 8192, 16384, 32768, 65536};
  const int results[] = {0, 10, 522};
  int page, mode, error, fixed, count = 0, mismatch = 0;
  for (page = 0; page < 8; ++page) {
    for (mode = 0; mode < 3; ++mode) {
      int output_size = mode == 0 ? sizes[page] / 2 : mode == 1 ? sizes[page] : sizes[page] * 2;
      for (error = 0; error < 3; ++error) {
        for (fixed = 0; fixed < 2; ++fixed) {
          int status = run_case(sizes[page], output_size, results[error], fixed);
          if (status) {
            fprintf(stderr, "wal-contract-failed page=%d mode=%d error=%d fixed=%d check=%d\n", page, mode, error, fixed, status);
            return 1;
          }
        }
        ++count;
        if (mode == 2) ++mismatch;
      }
    }
  }
  printf("sqlite-wal-cases %d baseline-stale-tail %d fixed-zero-tail %d\n", count, mismatch, mismatch);
  return count == 72 && mismatch == 24 ? 0 : 1;
}
