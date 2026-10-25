/* Descriptor-relative filesystem operations for platforms without /proc/self/fd. */
#define _POSIX_C_SOURCE 200809L
#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#endif
#include <node_api.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_BYTES (32 * 1024 * 1024)

static napi_value fail(napi_env env, const char *message) {
  napi_value text, error, code;
  const char *name = errno == ENOENT ? "ENOENT" : "EUNSAFE";
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text);
  napi_create_error(env, NULL, text, &error);
  napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &code);
  napi_set_named_property(env, error, "code", code);
  napi_throw(env, error);
  return NULL;
}

static char *text_arg(napi_env env, napi_value value) {
  size_t length, copied;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length > 65535) return NULL;
  char *text = malloc(length + 1);
  if (!text) return NULL;
  if (napi_get_value_string_utf8(env, value, text, length + 1, &copied) != napi_ok ||
      copied != length || strlen(text) != length) { free(text); return NULL; }
  return text;
}

static int parent_fd(char *path, int create, char **leaf) {
  if (path[0] != '/') { errno = EINVAL; return -1; }
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) return -1;
  char *part = path + 1;
  for (;;) {
    char *slash = strchr(part, '/');
    if (slash) *slash = '\0';
    if (!*part || !strcmp(part, ".") || !strcmp(part, "..")) { close(fd); errno = EINVAL; return -1; }
    if (!slash) { *leaf = part; return fd; }
    if (create && mkdirat(fd, part, 0755) < 0 && errno != EEXIST) { int err = errno; close(fd); errno = err; return -1; }
    int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int err = errno;
    close(fd);
    if (next < 0) { errno = err; return -1; }
    fd = next;
    part = slash + 1;
  }
}

static napi_value read_file(napi_env env, napi_callback_info info) {
  napi_value args[1], result, data, mode;
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  char *path = argc == 1 ? text_arg(env, args[0]) : NULL, *leaf;
  if (!path) { errno = EINVAL; return fail(env, "Invalid managed path"); }
  int parent = parent_fd(path, 0, &leaf), fd = -1;
  if (parent >= 0) fd = openat(parent, leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  int err = errno;
  if (parent >= 0) close(parent);
  free(path);
  if (fd < 0) {
    if (err == ENOENT) { napi_get_null(env, &result); return result; }
    errno = err; return fail(env, "Unsafe or unavailable managed file");
  }
  struct stat st;
  if (fstat(fd, &st) < 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_size < 0 || st.st_size > MAX_BYTES) {
    close(fd); errno = EINVAL; return fail(env, "Unsafe or oversized managed file");
  }
  size_t size = (size_t)st.st_size, used = 0;
  char *buffer = malloc(size ? size : 1);
  if (!buffer) { close(fd); errno = ENOMEM; return fail(env, "Managed read allocation failed"); }
  while (used < size) {
    ssize_t count = read(fd, buffer + used, size - used);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { free(buffer); close(fd); errno = EIO; return fail(env, "Managed file changed during read"); }
    used += (size_t)count;
  }
  char extra;
  ssize_t count;
  do { count = read(fd, &extra, 1); } while (count < 0 && errno == EINTR);
  close(fd);
  if (count != 0) { free(buffer); errno = EIO; return fail(env, "Managed file changed during read"); }
  napi_create_object(env, &result);
  napi_create_buffer_copy(env, size, buffer, NULL, &data);
  free(buffer);
  napi_create_uint32(env, st.st_mode & 0777, &mode);
  napi_set_named_property(env, result, "bytes", data);
  napi_set_named_property(env, result, "mode", mode);
  return result;
}

static napi_value write_file(napi_env env, napi_callback_info info) {
  napi_value args[4], result;
  size_t argc = 4, size = 0;
  uint32_t mode = 0;
  void *data = NULL;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  char *path = argc == 4 ? text_arg(env, args[0]) : NULL;
  char *temporary = argc == 4 ? text_arg(env, args[3]) : NULL, *leaf;
  if (!path || !temporary || strchr(temporary, '/') || strncmp(temporary, ".star-write-", 12) ||
      napi_get_buffer_info(env, args[1], &data, &size) != napi_ok || size > MAX_BYTES ||
      napi_get_value_uint32(env, args[2], &mode) != napi_ok || mode > 0777) {
    free(path); free(temporary); errno = EINVAL; return fail(env, "Invalid managed write");
  }
  int parent = parent_fd(path, 1, &leaf);
  if (parent < 0) { free(path); free(temporary); return fail(env, "Unsafe managed parent"); }
  struct stat existing;
  int found = fstatat(parent, leaf, &existing, AT_SYMLINK_NOFOLLOW);
  if ((found == 0 && (!S_ISREG(existing.st_mode) || existing.st_nlink != 1)) || (found < 0 && errno != ENOENT)) {
    close(parent); free(path); free(temporary); errno = EINVAL; return fail(env, "Unsafe managed destination");
  }
  int fd = openat(parent, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) { close(parent); free(path); free(temporary); return fail(env, "Cannot create managed temporary file"); }
  size_t used = 0;
  int ok = 1;
  while (used < size) {
    ssize_t count = write(fd, (char *)data + used, size - used);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { ok = 0; break; }
    used += (size_t)count;
  }
  if (ok && (fchmod(fd, mode) < 0 || fsync(fd) < 0)) ok = 0;
  if (close(fd) < 0) ok = 0;
  if (ok && renameat(parent, temporary, parent, leaf) < 0) ok = 0;
  int err = errno;
  unlinkat(parent, temporary, 0);
  close(parent); free(path); free(temporary);
  if (!ok) { errno = err; return fail(env, "Managed atomic write failed"); }
  napi_get_undefined(env, &result);
  return result;
}

static napi_value directory(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  char *path = argc == 1 ? text_arg(env, args[0]) : NULL, *leaf;
  if (!path) { errno = EINVAL; return fail(env, "Invalid managed directory"); }
  int parent = parent_fd(path, 0, &leaf), fd = -1;
  if (parent >= 0) fd = openat(parent, leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  int err = errno;
  if (parent >= 0) close(parent);
  free(path);
  if (fd >= 0) close(fd);
  if (fd < 0 && err != ENOENT) { errno = err; return fail(env, "Unsafe managed directory"); }
  napi_get_boolean(env, fd >= 0, &result);
  return result;
}

static napi_value remove_file(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  char *path = argc == 1 ? text_arg(env, args[0]) : NULL, *leaf;
  if (!path) { errno = EINVAL; return fail(env, "Invalid managed removal"); }
  int parent = parent_fd(path, 0, &leaf), ok = 0;
  struct stat st;
  if (parent >= 0 && fstatat(parent, leaf, &st, AT_SYMLINK_NOFOLLOW) == 0 && S_ISREG(st.st_mode) && st.st_nlink == 1) {
    ok = unlinkat(parent, leaf, 0) == 0;
  }
  int err = errno;
  if (parent >= 0) close(parent);
  free(path);
  if (!ok) { errno = err; return fail(env, "Unsafe or unavailable managed removal"); }
  napi_get_undefined(env, &result);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"read", NULL, read_file, NULL, NULL, NULL, napi_default, NULL},
    {"write", NULL, write_file, NULL, NULL, NULL, napi_default, NULL},
    {"directory", NULL, directory, NULL, NULL, NULL, napi_default, NULL},
    {"remove", NULL, remove_file, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
