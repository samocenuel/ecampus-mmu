import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api.dart';
import '../core/app_state.dart';

const dayNames = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const dayShort = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const roleLabels = {
  'super_admin': 'Platform owner',
  'admin': 'Administrator',
  'dean': 'Dean',
  'hod': 'Head of Department',
  'lecturer': 'Lecturer',
  'student': 'Student',
  'hr': 'HR (Directorate)',
};

Api apiOf(BuildContext context) => context.read<AppState>().api;

void showMessage(BuildContext context, String message, {bool error = false}) {
  final messenger = ScaffoldMessenger.maybeOf(context);
  messenger?.hideCurrentSnackBar();
  messenger?.showSnackBar(SnackBar(
    content: Text(message),
    behavior: SnackBarBehavior.floating,
    backgroundColor: error ? Theme.of(context).colorScheme.error : null,
  ));
}

void showError(BuildContext context, Object err) => showMessage(context, err.toString(), error: true);

Future<bool> confirmDialog(BuildContext context, {required String title, required String message, String confirmLabel = 'Confirm', bool danger = false, Widget? details}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      icon: Icon(danger ? Icons.warning_amber_rounded : Icons.help_outline, color: danger ? Theme.of(ctx).colorScheme.error : Colors.orange.shade800),
      title: Text(title),
      content: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [Text(message), if (details != null) ...[const SizedBox(height: 12), details]]),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        FilledButton(
          style: danger ? FilledButton.styleFrom(backgroundColor: Theme.of(ctx).colorScheme.error) : null,
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return result ?? false;
}

/// Runs [action] and, if the server asks for confirmation (e.g. "allocate
/// cross-cutting units first"), shows the warning and retries with force.
Future<T?> runWithConfirm<T>(BuildContext context, Future<T> Function(bool force) action) async {
  try {
    return await action(false);
  } on ApiException catch (e) {
    if (!e.needsConfirmation || !context.mounted) rethrow;
    Widget? details;
    final pending = e.data['pending'] as List?;
    final warnings = e.data['warnings'] as List?;
    if (pending != null && pending.isNotEmpty) {
      details = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final p in pending)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text('• ${p['code']} ${p['name']} - ${(p['pending_classes'] as List).join(', ')}', style: const TextStyle(fontSize: 13)),
            ),
        ],
      );
    } else if (warnings != null && warnings.isNotEmpty) {
      details = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [for (final w in warnings) Text('• $w', style: const TextStyle(fontSize: 13))]);
    }
    final code = e.data['code'] as String? ?? '';
    final ok = await confirmDialog(
      context,
      title: code.startsWith('CROSS_CUTTING') ? 'Cross-cutting units first' : 'Please confirm',
      message: e.message,
      details: details,
      confirmLabel: 'Continue anyway',
    );
    if (!ok) return null;
    return action(true);
  }
}

/// Loads data with a spinner, error + retry, and pull-to-refresh.
class AsyncView<T> extends StatefulWidget {
  const AsyncView({super.key, required this.load, required this.builder});

  final Future<T> Function() load;
  final Widget Function(BuildContext context, T data, Future<void> Function() reload) builder;

  @override
  State<AsyncView<T>> createState() => _AsyncViewState<T>();
}

class _AsyncViewState<T> extends State<AsyncView<T>> {
  T? _data;
  Object? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  @override
  void didUpdateWidget(covariant AsyncView<T> oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.key != widget.key) _reload();
  }

  Future<void> _reload() async {
    setState(() => _loading = true);
    try {
      final data = await widget.load();
      if (!mounted) return;
      setState(() {
        _data = data;
        _error = null;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _data == null) return const Center(child: CircularProgressIndicator());
    if (_error != null && _data == null) {
      return EmptyView(
        icon: Icons.cloud_off_outlined,
        title: 'Could not load',
        message: _error.toString(),
        action: FilledButton.tonal(onPressed: _reload, child: const Text('Try again')),
      );
    }
    return RefreshIndicator(onRefresh: _reload, child: widget.builder(context, _data as T, _reload));
  }
}

class EmptyView extends StatelessWidget {
  const EmptyView({super.key, required this.icon, required this.title, this.message, this.action});

  final IconData icon;
  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          CircleAvatar(radius: 28, backgroundColor: scheme.primaryContainer, child: Icon(icon, color: scheme.onPrimaryContainer)),
          const SizedBox(height: 12),
          Text(title, style: Theme.of(context).textTheme.titleMedium, textAlign: TextAlign.center),
          if (message != null) ...[
            const SizedBox(height: 4),
            Text(message!, style: TextStyle(color: scheme.onSurfaceVariant), textAlign: TextAlign.center),
          ],
          if (action != null) ...[const SizedBox(height: 16), action!],
        ]),
      ),
    );
  }
}

class SectionCard extends StatelessWidget {
  const SectionCard({super.key, this.title, this.trailing, required this.child, this.padding = const EdgeInsets.all(16)});

  final String? title;
  final Widget? trailing;
  final Widget child;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: padding,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (title != null || trailing != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(children: [
                if (title != null) Expanded(child: Text(title!, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600))),
                ?trailing,
              ]),
            ),
          child,
        ]),
      ),
    );
  }
}

class StatTile extends StatelessWidget {
  const StatTile({super.key, required this.label, required this.value, this.icon, this.color});

  final String label;
  final String value;
  final IconData? icon;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: scheme.surfaceContainerHighest.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(14)),
      child: Row(children: [
        if (icon != null) ...[
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(color: scheme.primaryContainer, borderRadius: BorderRadius.circular(10)),
            child: Icon(icon, size: 20, color: scheme.onPrimaryContainer),
          ),
          const SizedBox(width: 12),
        ],
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(value, style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: color ?? scheme.onSurface)),
            Text(label, style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant), maxLines: 2),
          ]),
        ),
      ]),
    );
  }
}

/// Two-column grid of stat tiles that adapts to wider screens.
class StatGrid extends StatelessWidget {
  const StatGrid({super.key, required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      final cols = c.maxWidth > 700 ? 4 : 2;
      final w = (c.maxWidth - (cols - 1) * 10) / cols;
      return Wrap(spacing: 10, runSpacing: 10, children: [for (final child in children) SizedBox(width: w, child: child)]);
    });
  }
}

Color rateColor(BuildContext context, num? rate) {
  if (rate == null) return Theme.of(context).colorScheme.onSurfaceVariant;
  if (rate >= 80) return Colors.green.shade700;
  if (rate >= 75) return Colors.orange.shade800;
  return Theme.of(context).colorScheme.error;
}

String rateText(num? rate) => rate == null ? '-' : '${rate % 1 == 0 ? rate.toInt() : rate}%';

class StatusChip extends StatelessWidget {
  const StatusChip(this.status, {super.key});
  final String status;

  @override
  Widget build(BuildContext context) {
    final (label, color) = switch (status) {
      'approved' => ('Approved', Colors.green.shade700),
      'rejected' => ('Rejected', Theme.of(context).colorScheme.error),
      'submitted' => ('Awaiting approval', Colors.orange.shade800),
      'not_taken' => ('Not taken', Colors.blueGrey),
      'not_started' => ('Not started', Colors.blueGrey),
      _ => (status, Colors.blueGrey),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(20)),
      child: Text(label, style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600)),
    );
  }
}

class CcBadge extends StatelessWidget {
  const CcBadge({super.key});
  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(left: 6),
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
        decoration: BoxDecoration(color: const Color(0xFFFEF0C7), borderRadius: BorderRadius.circular(4)),
        child: const Text('CC', style: TextStyle(color: Color(0xFF93370D), fontSize: 10.5, fontWeight: FontWeight.w700)),
      );
}

const _palette = [Color(0xFF3E63DD), Color(0xFF12B76A), Color(0xFFC11574), Color(0xFF0086C9), Color(0xFF6938EF), Color(0xFFE04F16), Color(0xFF0E9384), Color(0xFFE31B54)];

Color sessionColor(Map s) => s['is_cross_cutting'] == 1 ? const Color(0xFFDC6803) : _palette[((s['course_unit_id'] as num?)?.toInt() ?? 0) % _palette.length];

/// One lecture: time, course, room, lecturer/classes.
class SessionTile extends StatelessWidget {
  const SessionTile({super.key, required this.session, this.showClasses = true, this.trailing, this.onTap, this.subtitlePrefix});

  final Map session;
  final bool showClasses;
  final Widget? trailing;
  final VoidCallback? onTap;
  final String? subtitlePrefix;

  @override
  Widget build(BuildContext context) {
    final s = session;
    final scheme = Theme.of(context).colorScheme;
    final classes = (s['classes'] as List? ?? []).map((c) => c['name']).join(', ');
    final lecturer = '${s['lecturer_title'] != null ? '${s['lecturer_title']} ' : ''}${s['lecturer_name']}';
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: IntrinsicHeight(
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Container(width: 4, color: sessionColor(s)),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 12, 8, 12),
              child: Column(children: [
                Text(s['start_time'], style: const TextStyle(fontWeight: FontWeight.w700)),
                Text(s['end_time'], style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 12)),
              ]),
            ),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Flexible(child: Text('${s['course_code']}  ${s['course_name']}', style: const TextStyle(fontWeight: FontWeight.w600), maxLines: 2, overflow: TextOverflow.ellipsis)),
                    if (s['is_cross_cutting'] == 1) const CcBadge(),
                  ]),
                  const SizedBox(height: 4),
                  Wrap(spacing: 12, runSpacing: 2, children: [
                    _meta(context, Icons.place_outlined, '${s['room_name']}${s['room_building'] != null ? ', ${s['room_building']}' : ''}'),
                    _meta(context, Icons.person_outline, lecturer),
                    if (showClasses && classes.isNotEmpty) _meta(context, Icons.groups_outlined, classes),
                    if (subtitlePrefix != null) _meta(context, Icons.class_outlined, subtitlePrefix!),
                  ]),
                ]),
              ),
            ),
            if (trailing != null) Padding(padding: const EdgeInsets.only(right: 10), child: Center(child: trailing)),
          ]),
        ),
      ),
    );
  }

  Widget _meta(BuildContext context, IconData icon, String text) {
    final color = Theme.of(context).colorScheme.onSurfaceVariant;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Icon(icon, size: 14, color: color),
      const SizedBox(width: 3),
      Flexible(child: Text(text, style: TextStyle(fontSize: 12.5, color: color), overflow: TextOverflow.ellipsis)),
    ]);
  }
}

class UniversityLogo extends StatelessWidget {
  const UniversityLogo({super.key, this.size = 40});
  final double size;

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final url = app.logoUrl;
    final name = (app.university?['short_name'] ?? app.university?['name'] ?? 'LMS') as String;
    final scheme = Theme.of(context).colorScheme;
    if (url != null) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(size / 5),
        child: Image.network(url, width: size, height: size, fit: BoxFit.contain, errorBuilder: (_, _, _) => _initials(scheme, name)),
      );
    }
    return _initials(scheme, name);
  }

  Widget _initials(ColorScheme scheme, String name) => Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: scheme.primary, borderRadius: BorderRadius.circular(size / 4)),
        child: Text(name.substring(0, name.length < 3 ? name.length : 3).toUpperCase(), style: TextStyle(color: scheme.onPrimary, fontWeight: FontWeight.w800, fontSize: size * 0.3)),
      );
}

String niceDate(String isoDate) {
  final d = DateTime.parse(isoDate);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${dayShort[d.weekday]} ${d.day} ${months[d.month - 1]} ${d.year}';
}

String isoDate(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
