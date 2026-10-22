import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';

/// Error returned by the REST API. A 409 with `requires_confirmation` can be
/// overridden by resending the request with `force: true`.
class ApiException implements Exception {
  ApiException(this.status, this.data, this.message);

  final int status;
  final Map<String, dynamic> data;
  final String message;

  bool get needsConfirmation => status == 409 && data['requires_confirmation'] == true;

  @override
  String toString() => message;
}

class Api {
  Api(this.baseUrl);

  String baseUrl;
  String? token;
  final http.Client _client = http.Client();

  Uri _uri(String path) => Uri.parse('${baseUrl.replaceAll(RegExp(r'/$'), '')}$path');

  /// Absolute URL for a server-relative path such as `/uploads/logos/x.png`.
  String? absolute(String? path) {
    if (path == null || path.isEmpty) return null;
    return path.startsWith('http') ? path : _uri(path).toString();
  }

  Map<String, String> get _headers => {
        'Accept': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      };

  Future<dynamic> get(String path) => _send(() => _client.get(_uri(path), headers: _headers));

  Future<dynamic> post(String path, [Object? body]) => _send(() => _client.post(
        _uri(path),
        headers: {..._headers, 'Content-Type': 'application/json'},
        body: jsonEncode(body ?? {}),
      ));

  Future<dynamic> put(String path, [Object? body]) => _send(() => _client.put(
        _uri(path),
        headers: {..._headers, 'Content-Type': 'application/json'},
        body: jsonEncode(body ?? {}),
      ));

  Future<dynamic> delete(String path) => _send(() => _client.delete(_uri(path), headers: _headers));

  /// A form with text fields and an optional file (e.g. a research document).
  Future<dynamic> uploadForm(String path, Map<String, String> fields, {String method = 'POST', String field = 'document', List<int>? bytes, String? filename, String? contentType}) async {
    final request = http.MultipartRequest(method, _uri(path))
      ..headers.addAll(_headers)
      ..fields.addAll(fields);
    if (bytes != null) request.files.add(http.MultipartFile.fromBytes(field, bytes, filename: filename, contentType: _mediaType(contentType ?? 'application/octet-stream')));
    return _send(() async => http.Response.fromStream(await _client.send(request)));
  }

  Future<dynamic> upload(String path, String field, List<int> bytes, String filename, String contentType) async {
    final request = http.MultipartRequest('POST', _uri(path))
      ..headers.addAll(_headers)
      ..files.add(http.MultipartFile.fromBytes(field, bytes, filename: filename, contentType: _mediaType(contentType)));
    return _send(() async => http.Response.fromStream(await _client.send(request)));
  }

  Future<dynamic> _send(Future<http.Response> Function() call) async {
    http.Response res;
    try {
      res = await call().timeout(const Duration(seconds: 25));
    } on TimeoutException {
      throw ApiException(0, {}, 'The server took too long to respond.');
    } catch (_) {
      throw ApiException(0, {}, 'Cannot reach the server at $baseUrl. Check the server address and your connection.');
    }
    dynamic data;
    final isJson = (res.headers['content-type'] ?? '').contains('application/json');
    if (isJson && res.body.isNotEmpty) data = jsonDecode(utf8.decode(res.bodyBytes));
    if (res.statusCode >= 200 && res.statusCode < 300) return data;
    final map = data is Map<String, dynamic> ? data : <String, dynamic>{};
    throw ApiException(res.statusCode, map, (map['error'] as String?) ?? 'Request failed (${res.statusCode})');
  }
}

MediaType _mediaType(String contentType) => MediaType.parse(contentType);
