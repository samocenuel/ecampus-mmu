import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/app_state.dart';
import '../../widgets/common.dart';

enum FType { text, number, email, password, select, multiselect, toggle, date, multiline }

typedef Option = (Object value, String label);

/// A form field definition. Options can be static or come from a reference list.
class FSpec {
  const FSpec(this.name, this.label, {this.type = FType.text, this.required = false, this.ref, this.options, this.showIf, this.defaultValue, this.help});

  final String name;
  final String label;
  final FType type;
  final bool required;
  final String? ref;
  final List<Option>? options;
  final bool Function(Map<String, dynamic> form)? showIf;
  final dynamic defaultValue;
  final String? help;
}

/// A reference list (e.g. faculties for a "Faculty" select) loaded from the API.
class RefSpec {
  const RefSpec(this.endpoint, this.label);
  final String endpoint;
  final String Function(Map row) label;
}

class RSpec {
  const RSpec({
    required this.title,
    required this.noun,
    required this.endpoint,
    required this.titleOf,
    required this.fields,
    this.subtitleOf,
    this.badgeOf,
    this.query = '',
    this.refs = const {},
    this.canCreate = _always,
    this.canEdit = _always,
    this.canDelete = _always,
    this.fromRow,
    this.toPayload,
    this.actions,
    this.deleteMessage = 'This cannot be undone.',
    this.onCreated,
    this.intro,
  });

  final String title;
  final String noun;
  final String endpoint;
  final String query;
  final String Function(Map row) titleOf;
  final String Function(Map row)? subtitleOf;
  final String? Function(Map row)? badgeOf;
  final List<FSpec> fields;
  final Map<String, RefSpec> refs;
  final bool Function(AppState app) canCreate;
  final bool Function(AppState app) canEdit;
  final bool Function(AppState app) canDelete;
  final Map<String, dynamic> Function(Map row)? fromRow;
  final Map<String, dynamic> Function(Map<String, dynamic> form, bool creating)? toPayload;
  final List<Widget> Function(BuildContext context, Map row, Future<void> Function() reload)? actions;
  final String deleteMessage;
  /// Called after a successful create, before the form closes (e.g. to show a temporary password).
  final Future<void> Function(BuildContext context, Map result)? onCreated;
  final String? intro;
}

bool _always(AppState _) => true;

class ResourceScreen extends StatefulWidget {
  const ResourceScreen({super.key, required this.spec});
  final RSpec spec;

  @override
  State<ResourceScreen> createState() => _ResourceScreenState();
}

class _ResourceScreenState extends State<ResourceScreen> {
  int _version = 0;
  String _search = '';

  RSpec get spec => widget.spec;

  Future<Map<String, List<Option>>> _loadRefs() async {
    final api = context.read<AppState>().api;
    final out = <String, List<Option>>{};
    for (final e in spec.refs.entries) {
      final rows = await api.get(e.value.endpoint) as List;
      out[e.key] = [for (final r in rows) (r['id'] as Object, e.value.label(r as Map))];
    }
    return out;
  }

  Future<void> _openForm(Map? row) async {
    final refs = await _loadRefs();
    if (!mounted) return;
    final saved = await Navigator.of(context).push<bool>(MaterialPageRoute(
      fullscreenDialog: true,
      builder: (_) => _ResourceForm(spec: spec, refs: refs, row: row),
    ));
    if (saved == true) setState(() => _version++);
  }

  Future<void> _delete(Map row) async {
    final ok = await confirmDialog(context, title: 'Delete ${spec.noun.toLowerCase()}?', message: spec.deleteMessage, confirmLabel: 'Delete', danger: true);
    if (!ok || !mounted) return;
    try {
      await context.read<AppState>().api.delete('${spec.endpoint}/${row['id']}');
      if (mounted) showMessage(context, '${spec.noun} deleted');
      setState(() => _version++);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.read<AppState>();
    return Scaffold(
      appBar: AppBar(title: Text(spec.title)),
      floatingActionButton: spec.canCreate(app)
          ? FloatingActionButton.extended(onPressed: () => _openForm(null), icon: const Icon(Icons.add), label: Text('New ${spec.noun.toLowerCase()}'))
          : null,
      body: AsyncView<List>(
        key: ValueKey('${spec.endpoint}${spec.query}-$_version'),
        load: () async => await app.api.get('${spec.endpoint}${spec.query}') as List,
        builder: (context, rows, reload) {
          final q = _search.toLowerCase();
          final filtered = rows.where((r) => q.isEmpty || '${spec.titleOf(r)} ${spec.subtitleOf?.call(r) ?? ''}'.toLowerCase().contains(q)).toList();
          return ListView(padding: const EdgeInsets.fromLTRB(12, 12, 12, 96), children: [
            if (spec.intro != null)
              Padding(padding: const EdgeInsets.only(bottom: 10), child: Text(spec.intro!, style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant))),
            TextField(
              decoration: InputDecoration(prefixIcon: const Icon(Icons.search), hintText: 'Search ${rows.length} ${spec.title.toLowerCase()}'),
              onChanged: (v) => setState(() => _search = v),
            ),
            const SizedBox(height: 10),
            if (filtered.isEmpty) EmptyView(icon: Icons.inbox_outlined, title: rows.isEmpty ? 'No ${spec.title.toLowerCase()} yet' : 'No matches'),
            for (final r in filtered)
              Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: ListTile(
                  title: Row(children: [
                    Flexible(child: Text(spec.titleOf(r), style: const TextStyle(fontWeight: FontWeight.w600))),
                    if (spec.badgeOf?.call(r) != null)
                      Container(
                        margin: const EdgeInsets.only(left: 6),
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                        decoration: BoxDecoration(color: const Color(0xFFFEF0C7), borderRadius: BorderRadius.circular(6)),
                        child: Text(spec.badgeOf!(r)!, style: const TextStyle(fontSize: 11, color: Color(0xFF93370D), fontWeight: FontWeight.w700)),
                      ),
                  ]),
                  subtitle: spec.subtitleOf != null ? Text(spec.subtitleOf!(r)) : null,
                  onTap: spec.canEdit(app) ? () => _openForm(r) : null,
                  trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                    ...?spec.actions?.call(context, r, () async => setState(() => _version++)),
                    if (spec.canDelete(app))
                      IconButton(icon: const Icon(Icons.delete_outline), tooltip: 'Delete', onPressed: () => _delete(r)),
                  ]),
                ),
              ),
          ]);
        },
      ),
    );
  }
}

class _ResourceForm extends StatefulWidget {
  const _ResourceForm({required this.spec, required this.refs, this.row});
  final RSpec spec;
  final Map<String, List<Option>> refs;
  final Map? row;

  @override
  State<_ResourceForm> createState() => _ResourceFormState();
}

class _ResourceFormState extends State<_ResourceForm> {
  final _key = GlobalKey<FormState>();
  late Map<String, dynamic> form;
  bool _busy = false;

  bool get creating => widget.row == null;

  @override
  void initState() {
    super.initState();
    if (creating) {
      form = {for (final f in widget.spec.fields) if (f.defaultValue != null) f.name: f.defaultValue};
    } else {
      form = widget.spec.fromRow != null ? widget.spec.fromRow!(widget.row!) : Map<String, dynamic>.from(widget.row!);
    }
  }

  Future<void> _save() async {
    if (!_key.currentState!.validate()) return;
    _key.currentState!.save();
    final spec = widget.spec;
    final visible = spec.fields.where((f) => f.showIf == null || f.showIf!(form));
    final payload = spec.toPayload != null
        ? spec.toPayload!(form, creating)
        : {for (final f in visible) f.name: (form[f.name] == '' ? null : form[f.name])};
    setState(() => _busy = true);
    final api = context.read<AppState>().api;
    try {
      final result = await runWithConfirm(
        context,
        (force) => creating ? api.post(spec.endpoint, {...payload, 'force': force}) : api.put('${spec.endpoint}/${widget.row!['id']}', {...payload, 'force': force}),
      );
      if (result == null || !mounted) return;
      showMessage(context, '${spec.noun} ${creating ? 'created' : 'saved'}');
      if (creating) await spec.onCreated?.call(context, result as Map);
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _field(FSpec f) {
    final options = f.options ?? widget.refs[f.ref] ?? const <Option>[];
    final label = f.required ? '${f.label} *' : f.label;
    switch (f.type) {
      case FType.toggle:
        return SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(f.label),
          subtitle: f.help != null ? Text(f.help!) : null,
          value: form[f.name] == true || form[f.name] == 1,
          onChanged: (v) => setState(() => form[f.name] = v),
        );
      case FType.select:
        final current = form[f.name];
        final match = options.where((o) => '${o.$1}' == '$current').toList();
        return DropdownButtonFormField<String>(
          initialValue: match.isEmpty ? null : '${match.first.$1}',
          isExpanded: true,
          decoration: InputDecoration(labelText: label, helperText: f.help),
          items: [
            if (!f.required) const DropdownMenuItem<String>(value: '', child: Text('— None —')),
            for (final o in options) DropdownMenuItem(value: '${o.$1}', child: Text(o.$2, overflow: TextOverflow.ellipsis)),
          ],
          validator: (v) => f.required && (v == null || v.isEmpty) ? 'Required' : null,
          onChanged: (v) => setState(() => form[f.name] = v),
        );
      case FType.multiselect:
        final selected = ((form[f.name] as List?) ?? []).map((e) => '$e').toSet();
        return InputDecorator(
          decoration: InputDecoration(labelText: label, helperText: f.help, border: InputBorder.none),
          child: Wrap(spacing: 6, runSpacing: 6, children: [
            for (final o in options)
              FilterChip(
                label: Text(o.$2),
                selected: selected.contains('${o.$1}'),
                onSelected: (v) => setState(() {
                  v ? selected.add('${o.$1}') : selected.remove('${o.$1}');
                  form[f.name] = selected.toList();
                }),
              ),
          ]),
        );
      case FType.date:
        return InkWell(
          onTap: () async {
            final now = DateTime.now();
            final d = await showDatePicker(
              context: context,
              initialDate: DateTime.tryParse('${form[f.name] ?? ''}') ?? now,
              firstDate: DateTime(now.year - 5),
              lastDate: DateTime(now.year + 5),
            );
            if (d != null) setState(() => form[f.name] = isoDate(d));
          },
          child: InputDecorator(decoration: InputDecoration(labelText: label, suffixIcon: const Icon(Icons.event)), child: Text('${form[f.name] ?? 'Select date'}')),
        );
      default:
        return TextFormField(
          initialValue: form[f.name] == null ? '' : '${form[f.name]}',
          keyboardType: switch (f.type) {
            FType.number => TextInputType.number,
            FType.email => TextInputType.emailAddress,
            FType.multiline => TextInputType.multiline,
            _ => TextInputType.text,
          },
          maxLines: f.type == FType.multiline ? 3 : 1,
          obscureText: f.type == FType.password,
          decoration: InputDecoration(labelText: label, helperText: f.help),
          validator: (v) => f.required && (v == null || v.trim().isEmpty) ? 'Required' : null,
          onChanged: (v) => form[f.name] = f.type == FType.number ? int.tryParse(v) : v,
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final fields = widget.spec.fields.where((f) => f.showIf == null || f.showIf!(form)).toList();
    return Scaffold(
      appBar: AppBar(
        title: Text('${creating ? 'New' : 'Edit'} ${widget.spec.noun.toLowerCase()}'),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: FilledButton(onPressed: _busy ? null : _save, child: Text(creating ? 'Create' : 'Save')),
          ),
        ],
      ),
      body: Form(
        key: _key,
        child: ListView(padding: const EdgeInsets.all(16), children: [
          for (final f in fields) Padding(padding: const EdgeInsets.only(bottom: 14), child: _field(f)),
        ]),
      ),
    );
  }
}
