import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/app_state.dart';
import '../widgets/common.dart';

/// Research: Project (undergraduate), Dissertation (Master's) and Thesis (PhD), concept to clearance.
class ResearchScreen extends StatefulWidget {
  const ResearchScreen({super.key});

  @override
  State<ResearchScreen> createState() => _ResearchScreenState();
}

class _ResearchScreenState extends State<ResearchScreen> {
  int _version = 0;

  Future<void> _start(Map elig) async {
    final created = await Navigator.of(context).push<Map>(MaterialPageRoute(builder: (_) => ConceptPage(kind: elig['kind_label'] as String)));
    if (created != null && mounted) {
      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ResearchDetailScreen(id: created['id'] as int)));
      setState(() => _version++);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    if (app.isStudent) {
      return Scaffold(
        appBar: AppBar(title: const Text('Research')),
        body: AsyncView<List>(
          key: ValueKey('mine-$_version'),
          load: () async => [await app.api.get('/api/research/eligibility'), await app.api.get('/api/research?view=mine')],
          builder: (context, data, reload) {
            final elig = data[0] as Map;
            final mine = (data[1] as List).cast<Map>();
            return ListView(padding: const EdgeInsets.all(12), children: [
              if (elig['eligible'] == true)
                SectionCard(
                  title: 'Your ${'${elig['kind_label']}'.toLowerCase()}',
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Text('Submit a concept to your research coordinator. After the presentation, supervisors are assigned; then you submit ${elig['reports_required']} progress reports, your intent to submit and the final work, and defend it.'),
                    const SizedBox(height: 12),
                    FilledButton.icon(onPressed: () => _start(elig), icon: const Icon(Icons.add), label: Text('Start your ${'${elig['kind_label']}'.toLowerCase()}')),
                  ]),
                )
              else if (mine.isEmpty)
                EmptyView(icon: Icons.science_outlined, title: 'Research', message: '${elig['reason']}'),
              for (final p in mine) _ProjectTile(project: p, onOpen: () => setState(() => _version++)),
            ]);
          },
        ),
      );
    }
    const views = [('awaiting', 'Awaiting me'), ('supervising', 'I supervise'), ('all', 'All'), ('cleared', 'Cleared')];
    return DefaultTabController(
      length: views.length,
      child: Scaffold(
        appBar: AppBar(title: const Text('Research'), bottom: TabBar(isScrollable: true, tabAlignment: TabAlignment.start, tabs: [for (final v in views) Tab(text: v.$2)])),
        body: TabBarView(children: [
          for (final v in views)
            AsyncView<List>(
              key: ValueKey('${v.$1}-$_version'),
              load: () async => await app.api.get('/api/research?view=${v.$1}') as List,
              builder: (context, list, reload) => list.isEmpty
                  ? ListView(children: const [SizedBox(height: 60), EmptyView(icon: Icons.science_outlined, title: 'Nothing here')])
                  : ListView(padding: const EdgeInsets.all(12), children: [for (final p in list.cast<Map>()) _ProjectTile(project: p, onOpen: () => setState(() => _version++))]),
            ),
        ]),
      ),
    );
  }
}

class _ProjectTile extends StatelessWidget {
  const _ProjectTile({required this.project, required this.onOpen});
  final Map project;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final p = project;
    final scheme = Theme.of(context).colorScheme;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        title: Text('${p['title']}', style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text([
          '${p['kind_label']} · ${p['student_name']}',
          '${p['status_label']}',
          if (p['waiting_for'] != null && !['cleared', 'rejected'].contains(p['status'])) 'Waiting for: ${p['waiting_for']}',
        ].join('\n')),
        isThreeLine: true,
        trailing: (p['actions'] as List).any((a) => !['propose_mentor', 'assign_supervisor'].contains(a)) ? Icon(Icons.pending_actions, color: scheme.primary) : null,
        onTap: () async {
          await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ResearchDetailScreen(id: p['id'] as int)));
          onOpen();
        },
      ),
    );
  }
}

/// The student's concept: title, problem, objectives and methodology (and an optional paper).
class ConceptPage extends StatefulWidget {
  const ConceptPage({super.key, required this.kind, this.project});
  final String kind;
  final Map? project;

  @override
  State<ConceptPage> createState() => _ConceptPageState();
}

class _ConceptPageState extends State<ConceptPage> {
  late final _f = {for (final k in ['title', 'problem', 'objectives', 'methodology']) k: TextEditingController(text: '${widget.project?[k] ?? ''}')};
  PlatformFile? _file;
  bool _busy = false;

  Future<void> _send() async {
    if (_f['title']!.text.trim().isEmpty || _f['problem']!.text.trim().isEmpty || _f['objectives']!.text.trim().isEmpty) {
      return showMessage(context, 'Fill in the title, problem statement and objectives', error: true);
    }
    setState(() => _busy = true);
    try {
      final bytes = _file == null ? null : await _file!.readAsBytes();
      if (!mounted) return;
      final res = await context.read<AppState>().api.uploadForm(
            widget.project == null ? '/api/research' : '/api/research/${widget.project!['id']}/concept',
            {for (final e in _f.entries) e.key: e.value.text},
            method: widget.project == null ? 'POST' : 'PUT',
            bytes: bytes,
            filename: _file?.name,
            contentType: _mime(_file?.extension),
          );
      if (mounted) Navigator.pop(context, res as Map);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.project == null ? '${widget.kind} concept' : 'Revise concept')),
      bottomNavigationBar: SafeArea(child: Padding(padding: const EdgeInsets.all(12), child: FilledButton(onPressed: _busy ? null : _send, child: Text(widget.project == null ? 'Submit concept' : 'Resubmit concept')))),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        TextField(controller: _f['title'], decoration: const InputDecoration(labelText: 'Title *')),
        const SizedBox(height: 10),
        TextField(controller: _f['problem'], minLines: 3, maxLines: 6, decoration: const InputDecoration(labelText: 'Problem statement *')),
        const SizedBox(height: 10),
        TextField(controller: _f['objectives'], minLines: 2, maxLines: 5, decoration: const InputDecoration(labelText: 'Objectives *')),
        const SizedBox(height: 10),
        TextField(controller: _f['methodology'], minLines: 2, maxLines: 5, decoration: const InputDecoration(labelText: 'Methodology')),
        const SizedBox(height: 10),
        OutlinedButton.icon(
          onPressed: () async {
            final f = await pickDocument();
            if (f != null) setState(() => _file = f);
          },
          icon: const Icon(Icons.attach_file),
          label: Text(_file?.name ?? 'Attach concept paper (optional)'),
        ),
      ]),
    );
  }
}

Future<PlatformFile?> pickDocument() => FilePicker.pickFile(type: FileType.custom, allowedExtensions: ['pdf', 'doc', 'docx', 'ppt', 'pptx']);

String? _mime(String? ext) => switch ((ext ?? '').toLowerCase()) {
      'pdf' => 'application/pdf',
      'doc' => 'application/msword',
      'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'ppt' => 'application/vnd.ms-powerpoint',
      'pptx' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      _ => null,
    };

const _actionLabels = {
  'schedule_presentation': 'Schedule presentation',
  'return_concept': 'Return for revision',
  'reject': 'Not approve',
  'presentation_passed': 'Presentation passed',
  'presentation_revise': 'Revise after presentation',
  'approve_start': 'Approve to start',
  'sign_intent': 'Sign off intent',
  'return_intent': 'Return: outputs not clear',
  'sign_final': 'Approve final submission',
  'return_final': 'Return final submission',
  'schedule_defence': 'Schedule defence',
  'defence_passed': 'Defence passed',
  'defence_corrections': 'Corrections required',
  'approve_corrections': 'Accept corrections',
  'return_corrections': 'Return corrections',
  'clear': 'Approve and clear',
};
const _needsNote = {'return_concept', 'reject', 'presentation_revise', 'return_intent', 'return_final', 'defence_corrections', 'return_corrections'};
const _needsDate = {'schedule_presentation', 'schedule_defence'};
const _uploads = {
  'submit_report': ('Submit progress report', 'reports', false),
  'submit_intent': ('Submit intent to submit', 'intent', false),
  'submit_final': ('Submit final work', 'final', true),
  'submit_corrections': ('Submit corrections', 'corrections', true),
};

class ResearchDetailScreen extends StatefulWidget {
  const ResearchDetailScreen({super.key, required this.id});
  final int id;

  @override
  State<ResearchDetailScreen> createState() => _ResearchDetailScreenState();
}

class _ResearchDetailScreenState extends State<ResearchDetailScreen> {
  int _version = 0;

  void _refresh() => setState(() => _version++);

  Future<void> _call(Future<dynamic> Function() run, String done) async {
    try {
      await run();
      if (mounted) showMessage(context, done);
      _refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _assignSupervisor(Map p) async {
    final api = context.read<AppState>().api;
    List staff;
    try {
      staff = await api.get('/api/users?roles=lecturer,hod,dean&active=1') as List;
    } catch (e) {
      if (mounted) showError(context, e);
      return;
    }
    if (!mounted) return;
    int? userId;
    var role = (p['supervisors'] as List).any((s) => s['role'] == 'main') ? 'co' : 'main';
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: const Text('Assign supervisor'),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            DropdownButtonFormField<int>(
              isExpanded: true,
              initialValue: userId,
              decoration: const InputDecoration(labelText: 'Lecturer'),
              items: [for (final u in staff.cast<Map>()) DropdownMenuItem(value: u['id'] as int, child: Text('${u['name']}', overflow: TextOverflow.ellipsis))],
              onChanged: (v) => setLocal(() => userId = v),
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              initialValue: role,
              decoration: const InputDecoration(labelText: 'Role'),
              items: const [DropdownMenuItem(value: 'main', child: Text('Main supervisor')), DropdownMenuItem(value: 'co', child: Text('Co-supervisor'))],
              onChanged: (v) => setLocal(() => role = v ?? 'main'),
            ),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(onPressed: userId == null ? null : () => Navigator.pop(ctx, true), child: const Text('Assign')),
          ],
        ),
      ),
    );
    if (ok == true) await _call(() => api.post('/api/research/${p['id']}/supervisors', {'user_id': userId, 'role': role}), 'Supervisor assigned');
  }

  Future<void> _proposeMentor(Map p) async {
    final f = {for (final k in ['name', 'institution', 'email', 'phone']) k: TextEditingController()};
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Propose a mentor'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: f['name'], decoration: const InputDecoration(labelText: 'Name *')),
            TextField(controller: f['institution'], decoration: const InputDecoration(labelText: 'Institution or company')),
            TextField(controller: f['email'], keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Email')),
            TextField(controller: f['phone'], keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Phone')),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Propose')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    if (f['name']!.text.trim().isEmpty) return showMessage(context, 'Enter the mentor\'s name', error: true);
    await _call(() => context.read<AppState>().api.post('/api/research/${p['id']}/mentors', {for (final e in f.entries) e.key: e.value.text}), 'Mentor proposed; the coordinator will confirm');
  }

  Future<void> _act(Map p, String action) async {
    final note = TextEditingController();
    final venue = TextEditingController();
    final panel = TextEditingController();
    DateTime? date;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: Text(_actionLabels[action]!),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              if (_needsDate.contains(action)) ...[
                OutlinedButton.icon(
                  icon: const Icon(Icons.event),
                  label: Text(date == null ? 'Choose date and time *' : '${isoDate(date!)} ${date!.hour.toString().padLeft(2, '0')}:${date!.minute.toString().padLeft(2, '0')}'),
                  onPressed: () async {
                    final d = await showDatePicker(context: ctx, firstDate: DateTime.now().subtract(const Duration(days: 1)), lastDate: DateTime.now().add(const Duration(days: 365)), initialDate: DateTime.now());
                    if (d == null || !ctx.mounted) return;
                    final t = await showTimePicker(context: ctx, initialTime: const TimeOfDay(hour: 10, minute: 0));
                    if (t == null) return;
                    setLocal(() => date = DateTime(d.year, d.month, d.day, t.hour, t.minute));
                  },
                ),
                const SizedBox(height: 8),
                TextField(controller: venue, decoration: const InputDecoration(labelText: 'Venue')),
                if (action == 'schedule_defence') ...[const SizedBox(height: 8), TextField(controller: panel, decoration: const InputDecoration(labelText: 'Panel'))],
                const SizedBox(height: 8),
              ],
              TextField(controller: note, maxLines: 3, decoration: InputDecoration(labelText: _needsNote.contains(action) ? 'Note *' : 'Note (optional)')),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(onPressed: (_needsDate.contains(action) && date == null) ? null : () => Navigator.pop(ctx, true), child: Text(_actionLabels[action]!)),
          ],
        ),
      ),
    );
    if (ok != true || !mounted) return;
    try {
      final d = date;
      await context.read<AppState>().api.post('/api/research/${p['id']}/action', {
        'action': action,
        'note': note.text,
        if (d != null) 'date': '${isoDate(d)} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}',
        'venue': venue.text,
        'panel': panel.text,
      });
      if (mounted) showMessage(context, '${_actionLabels[action]}: done');
      _refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _upload(Map p, String action) async {
    final (label, path, fileRequired) = _uploads[action]!;
    final title = TextEditingController(text: action == 'submit_report' ? 'Progress report ${(p['approved_reports'] as num) + 1}' : '');
    final summary = TextEditingController();
    PlatformFile? file;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: Text(label),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              if (action == 'submit_report') TextField(controller: title, decoration: const InputDecoration(labelText: 'Title *')),
              TextField(controller: summary, minLines: 2, maxLines: 5, decoration: const InputDecoration(labelText: 'Summary')),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: () async {
                  final f = await pickDocument();
                  if (f != null) setLocal(() => file = f);
                },
                icon: const Icon(Icons.attach_file),
                label: Text(file?.name ?? (fileRequired ? 'Attach document *' : 'Attach document')),
              ),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(onPressed: fileRequired && file == null ? null : () => Navigator.pop(ctx, true), child: const Text('Submit')),
          ],
        ),
      ),
    );
    if (ok != true || !mounted) return;
    try {
      final f = file;
      final bytes = f == null ? null : await f.readAsBytes();
      if (!mounted) return;
      await context.read<AppState>().api.uploadForm('/api/research/${p['id']}/$path', {'title': title.text, 'summary': summary.text}, bytes: bytes, filename: f?.name, contentType: _mime(f?.extension));
      if (mounted) showMessage(context, 'Submitted');
      _refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _review(Map r, String action) async {
    final note = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('${action == 'approve' ? 'Approve' : 'Return'} report ${r['number']}'),
        content: TextField(controller: note, maxLines: 3, decoration: InputDecoration(labelText: action == 'return' ? 'What should change? *' : 'Comment (optional)')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(action == 'approve' ? 'Approve' : 'Return')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    try {
      await context.read<AppState>().api.post('/api/research/reports/${r['id']}/review', {'action': action, 'note': note.text});
      _refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.read<AppState>();
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Research')),
      body: AsyncView<Map<String, dynamic>>(
        key: ValueKey(_version),
        load: () async => await app.api.get('/api/research/${widget.id}') as Map<String, dynamic>,
        builder: (context, p, reload) {
          final actions = (p['actions'] as List).cast<String>();
          final cal = p['calendar'] as Map? ?? const {};
          return ListView(padding: const EdgeInsets.all(12), children: [
            SectionCard(
              title: '${p['title']}',
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${p['kind_label']} · ${p['student_name']}${p['student_identifier'] != null ? ' (${p['student_identifier']})' : ''}'),
                const SizedBox(height: 6),
                Text('${p['status_label']}', style: TextStyle(fontWeight: FontWeight.w700, color: p['status'] == 'cleared' ? Colors.green.shade700 : p['status'] == 'rejected' ? scheme.error : scheme.primary)),
                if (p['waiting_for'] != null && !['cleared', 'rejected'].contains(p['status'])) Text('Waiting for: ${p['waiting_for']}', style: TextStyle(color: scheme.onSurfaceVariant)),
                if (p['outcome_note'] != null) Text('Note: ${p['outcome_note']}'),
                const SizedBox(height: 10),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final a in actions)
                    if (_actionLabels.containsKey(a))
                      FilledButton.tonal(onPressed: () => _act(p, a), child: Text(_actionLabels[a]!))
                    else if (_uploads.containsKey(a))
                      FilledButton.icon(onPressed: () => _upload(p, a), icon: const Icon(Icons.upload_file), label: Text(_uploads[a]!.$1))
                    else if (a == 'resubmit_concept')
                      FilledButton.icon(
                        onPressed: () async {
                          await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ConceptPage(kind: p['kind_label'] as String, project: p)));
                          _refresh();
                        },
                        icon: const Icon(Icons.edit),
                        label: const Text('Revise concept'),
                      ),
                  if (p['status'] == 'cleared')
                    FilledButton.icon(
                      onPressed: () => app.openExport('/api/research/${p['id']}/certificate').catchError((e) {
                        if (context.mounted) showError(context, e);
                      }),
                      icon: const Icon(Icons.workspace_premium_outlined),
                      label: const Text('Clearance certificate'),
                    ),
                ]),
              ]),
            ),
            if (cal['presentation'] != null || cal['defence'] != null)
              SectionCard(
                title: 'Coming up',
                child: Column(children: [
                  if (cal['presentation'] != null)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.co_present_outlined),
                      title: const Text('Concept presentation'),
                      subtitle: Text('${p['presentation_at']}${p['presentation_venue'] != null ? ' · ${p['presentation_venue']}' : ''}'),
                      trailing: IconButton(tooltip: 'Add to Google Calendar', icon: const Icon(Icons.event_available), onPressed: () => launchUrl(Uri.parse(cal['presentation'] as String), mode: LaunchMode.externalApplication)),
                    ),
                  if (cal['defence'] != null)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.gavel_outlined),
                      title: const Text('Defence'),
                      subtitle: Text('${p['defence_at']}${p['defence_venue'] != null ? ' · ${p['defence_venue']}' : ''}${p['defence_panel'] != null ? '\nPanel: ${p['defence_panel']}' : ''}'),
                      trailing: IconButton(tooltip: 'Add to Google Calendar', icon: const Icon(Icons.event_available), onPressed: () => launchUrl(Uri.parse(cal['defence'] as String), mode: LaunchMode.externalApplication)),
                    ),
                ]),
              ),
            SectionCard(
              title: 'Supervisors and mentors',
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                if ((p['supervisors'] as List).isEmpty) Text('No supervisors yet', style: TextStyle(color: scheme.onSurfaceVariant)),
                for (final s in (p['supervisors'] as List))
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.person_outline),
                    title: Text('${s['name']}'),
                    subtitle: Text(s['role'] == 'main' ? 'Main supervisor' : 'Co-supervisor'),
                    trailing: actions.contains('assign_supervisor')
                        ? IconButton(tooltip: 'Remove', icon: const Icon(Icons.close), onPressed: () => _call(() => app.api.delete('/api/research/${p['id']}/supervisors/${s['id']}'), 'Supervisor removed'))
                        : null,
                  ),
                for (final m in (p['mentors'] as List))
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.handshake_outlined),
                    title: Text('Mentor: ${m['name']}'),
                    subtitle: Text([if (m['institution'] != null) '${m['institution']}', '${m['status']}'].join(' · ')),
                    trailing: actions.contains('decide_mentor') && m['status'] == 'proposed'
                        ? Row(mainAxisSize: MainAxisSize.min, children: [
                            IconButton(tooltip: 'Confirm', icon: const Icon(Icons.check_circle_outline), onPressed: () => _call(() => app.api.post('/api/research/${p['id']}/mentors/${m['id']}/decision', {'decision': 'confirm'}), 'Mentor confirmed')),
                            IconButton(tooltip: 'Decline', icon: const Icon(Icons.block), onPressed: () => _call(() => app.api.post('/api/research/${p['id']}/mentors/${m['id']}/decision', {'decision': 'decline'}), 'Mentor declined')),
                          ])
                        : null,
                  ),
                Wrap(spacing: 8, children: [
                  if (actions.contains('assign_supervisor')) TextButton.icon(onPressed: () => _assignSupervisor(p), icon: const Icon(Icons.person_add_alt), label: const Text('Assign supervisor')),
                  if (actions.contains('propose_mentor')) TextButton.icon(onPressed: () => _proposeMentor(p), icon: const Icon(Icons.group_add_outlined), label: const Text('Propose a mentor')),
                ]),
              ]),
            ),
            if ((p['reports'] as List).isNotEmpty || p['status'] == 'in_progress')
              SectionCard(
                title: 'Progress reports (${p['approved_reports']}/${p['reports_required']} approved)',
                child: Column(children: [
                  for (final r in (p['reports'] as List).cast<Map>())
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text('${r['number']}. ${r['title']}'),
                      subtitle: Text('${r['status']}${r['hod_note'] ?? r['supervisor_note'] != null ? ' · ${r['hod_note'] ?? r['supervisor_note']}' : ''}'),
                      trailing: actions.contains('review_report') && ['submitted', 'supervisor_approved'].contains(r['status'])
                          ? Row(mainAxisSize: MainAxisSize.min, children: [
                              IconButton(tooltip: 'Approve', icon: const Icon(Icons.check_circle_outline), onPressed: () => _review(r, 'approve')),
                              IconButton(tooltip: 'Return', icon: const Icon(Icons.undo), onPressed: () => _review(r, 'return')),
                            ])
                          : null,
                    ),
                ]),
              ),
            if ((p['documents'] as List? ?? const []).isNotEmpty)
              SectionCard(
                title: 'Documents',
                child: Column(children: [
                  for (final d in (p['documents'] as List).cast<Map>())
                    ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.description_outlined),
                      title: Text('${d['original_name']}'),
                      subtitle: Text('${d['stage']} · ${d['uploaded_by_name'] ?? ''} · ${d['created_at']}'),
                      trailing: IconButton(
                        tooltip: 'Download',
                        icon: const Icon(Icons.download),
                        onPressed: () => app.openExport('/api/research/documents/${d['id']}').catchError((e) {
                          if (context.mounted) showError(context, e);
                        }),
                      ),
                    ),
                ]),
              ),
            SectionCard(
              title: 'History and digital signatures',
              child: Column(children: [
                for (final e in (p['events'] as List).reversed)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(e['footprint'] != null ? Icons.verified_outlined : Icons.history, color: e['footprint'] != null ? Colors.green.shade700 : null),
                    title: Text('${e['actor_name'] ?? 'eCampus'} ${e['action']} · ${e['stage']}'),
                    subtitle: Text([if (e['note'] != null) '${e['note']}', '${e['created_at']}', if (e['footprint'] != null) 'Signature ${e['footprint']}'].join('\n')),
                  ),
              ]),
            ),
          ]);
        },
      ),
    );
  }
}
