import { describe, expect, it } from 'vitest';

import {
  buildGroupDependencyGraph,
  findGroupBlastRadius,
  findGroupDependencyCycles,
  findObjectReferences,
  GROUP_MEMBERSHIP_CRITERION_NAMES,
  isNegatedMembershipSearchType,
  readGroupMembershipCriteria,
  REFERENCE_MATRIX,
  type ComputerGroupDetail,
  type PolicyDetail,
} from './references.js';

// Every name in this file is deliberately invented. Real group and policy names are
// site data — see CONTRIBUTING.md.
const GROUP = 'Fictional Lab Macs';
const OTHER_GROUP = 'Pretend Kiosk Fleet';

function policy(overrides: PolicyDetail): PolicyDetail {
  return {
    general: { id: 100, name: 'Imaginary Nightly Task', enabled: true },
    scope: { computer_groups: [], exclusions: { computer_groups: [] } },
    scripts: [],
    package_configuration: { packages: [] },
    ...overrides,
  };
}

/** A group detail carrying a membership criterion pointing at `target`. */
function groupWithMembership(
  name: string,
  id: number,
  target: string,
  searchType = 'member of',
): ComputerGroupDetail {
  return {
    id,
    name,
    is_smart: true,
    criteria: [{ name: 'Computer Group', search_type: searchType, value: target, priority: 0 }],
  };
}

describe('REFERENCE_MATRIX', () => {
  // The matrix is the definition of complete coverage; drifting from Prune's
  // validated version silently shrinks what "clear" means.
  it('keeps Prune\'s validated usage matrix', () => {
    expect(REFERENCE_MATRIX.package).toEqual(['policy', 'patchPolicy', 'computerPrestage']);
    expect(REFERENCE_MATRIX.script).toEqual(['policy']);
    expect([...REFERENCE_MATRIX.computerGroup].sort()).toEqual([
      'advancedComputerSearch',
      'appInstaller',
      'blueprint',
      'computerGroup',
      'configurationProfile',
      'eBook',
      'policy',
      'restrictedSoftware',
    ]);
  });
});

describe('findObjectReferences — matching', () => {
  it('finds a package in a policy package slot and reports the id match', () => {
    const report = findObjectReferences(
      { kind: 'package', id: 42, name: 'Nonexistent Widget-1.0.pkg' },
      {
        policies: [
          policy({ package_configuration: { packages: [{ id: 42, name: 'Nonexistent Widget-1.0.pkg' }] } }),
        ],
      },
    );
    expect(report.references).toHaveLength(1);
    expect(report.references[0]?.matchedOn).toBe('id');
    expect(report.references[0]?.sense).toBe('attachment');
    expect(report.references[0]?.path).toBe('package_configuration.packages[0]');
    expect(report.references[0]?.sourceName).toBe('Imaginary Nightly Task');
    expect(report.references[0]?.sourceEnabled).toBe(true);
    expect(report.strength).toBe('referenced');
  });

  // Classic returns ids as JSON numbers, the Jamf Pro API as strings. Comparing
  // without normalising loses half the matches to 42 !== '42'.
  it('matches an id across the number/string inconsistency', () => {
    const byString = findObjectReferences(
      { kind: 'package', id: '42' },
      { policies: [policy({ package_configuration: { packages: [{ id: 42 }] } })] },
    );
    expect(byString.references).toHaveLength(1);
    const byNumber = findObjectReferences(
      { kind: 'package', id: 42 },
      { policies: [policy({ package_configuration: { packages: [{ id: '42' }] } })] },
    );
    expect(byNumber.references).toHaveLength(1);
  });

  it('matches a name case-insensitively when the id does not match', () => {
    const report = findObjectReferences(
      { kind: 'computerGroup', id: 7, name: GROUP },
      { policies: [policy({ scope: { computer_groups: [{ id: 999, name: GROUP.toUpperCase() }] } })] },
    );
    expect(report.references).toHaveLength(1);
    expect(report.references[0]?.matchedOn).toBe('name');
    expect(report.references[0]?.matchedValue).toBe(GROUP.toUpperCase());
  });

  // The single most important negative test in this file. A substring rule would
  // report a reference that is not there, and a delete-safety tool whose findings
  // all need manual confirmation has removed no work at all.
  it('does NOT match a name by substring', () => {
    const report = findObjectReferences(
      { kind: 'computerGroup', name: 'Fictional Lab' },
      {
        policies: [
          policy({ scope: { computer_groups: [{ id: 1, name: 'Fictional Lab Macs' }] } }),
          policy({ scope: { computer_groups: [{ id: 2, name: 'All Fictional Lab' }] } }),
        ],
      },
    );
    expect(report.references).toEqual([]);
    expect(report.strength).not.toBe('referenced');
  });

  it('prefers an id match over a name match when both would hit', () => {
    const report = findObjectReferences(
      { kind: 'computerGroup', id: 7, name: GROUP },
      { policies: [policy({ scope: { computer_groups: [{ id: 7, name: GROUP }] } })] },
    );
    expect(report.references[0]?.matchedOn).toBe('id');
  });

  it('ignores an empty or whitespace-only name rather than matching everything', () => {
    const report = findObjectReferences(
      { kind: 'computerGroup', id: 7, name: '   ' },
      { policies: [policy({ scope: { computer_groups: [{ id: 999, name: '' }] } })] },
    );
    expect(report.references).toEqual([]);
    expect(report.target.name).toBeUndefined();
  });
});

describe('findObjectReferences — inclusion versus exclusion', () => {
  // Opposite statements about the same pair of objects. Conflating them tells an
  // admin that deleting a group narrows a policy's reach when it widens it.
  it('distinguishes a scope exclusion from a scope inclusion', () => {
    const report = findObjectReferences(
      { kind: 'computerGroup', id: 7, name: GROUP },
      {
        policies: [
          policy({
            general: { id: 1, name: 'Imaginary Included Policy' },
            scope: { computer_groups: [{ id: 7, name: GROUP }] },
          }),
          policy({
            general: { id: 2, name: 'Imaginary Excluded Policy' },
            scope: { computer_groups: [], exclusions: { computer_groups: [{ id: 7, name: GROUP }] } },
          }),
        ],
      },
    );
    const senses = report.references.map((r) => r.sense);
    expect(senses).toContain('scope-inclusion');
    expect(senses).toContain('scope-exclusion');
    expect(report.totals.bySense['scope-exclusion']).toBe(1);
    const exclusion = report.references.find((r) => r.sense === 'scope-exclusion');
    expect(exclusion?.path).toBe('scope.exclusions.computer_groups[0]');
    expect(exclusion?.label).toContain('EXCLUSION');
  });

  it('says in the verdict that some references exclude rather than include', () => {
    const report = findObjectReferences(
      { kind: 'computerGroup', id: 7, name: GROUP },
      {
        policies: [
          policy({ scope: { computer_groups: [], exclusions: { computer_groups: [{ id: 7 }] } } }),
        ],
      },
    );
    expect(report.verdict).toContain('EXCLUDE');
  });

  // "not member of" is a real dependency with inverted sense. Reporting it as an
  // inclusion would be the most damaging error this module could make.
  it('separates a "not member of" criterion from a "member of" one', () => {
    const report = findObjectReferences(
      { kind: 'computerGroup', name: GROUP },
      {
        computerGroups: [
          groupWithMembership('Imaginary Positive Group', 1, GROUP, 'member of'),
          groupWithMembership('Imaginary Negative Group', 2, GROUP, 'not member of'),
        ],
      },
    );
    expect(report.totals.bySense['criterion-member-of']).toBe(1);
    expect(report.totals.bySense['criterion-not-member-of']).toBe(1);
    expect(report.references.map((r) => r.path)).toEqual(['criteria[0]', 'criteria[0]']);
  });
});

describe('findObjectReferences — reporting what was not checked', () => {
  it('lists every matrix source kind that was not supplied, with a consequence', () => {
    const report = findObjectReferences({ kind: 'computerGroup', name: GROUP }, { policies: [] });
    const skipped = report.notChecked.map((n) => n.sourceKind).sort();
    expect(skipped).toEqual([
      'advancedComputerSearch',
      'appInstaller',
      'blueprint',
      'computerGroup',
      'configurationProfile',
      'eBook',
      'restrictedSoftware',
    ]);
    for (const entry of report.notChecked) {
      expect(entry.reason, entry.sourceKind).not.toBe('');
      expect(entry.consequence.length, entry.sourceKind).toBeGreaterThan(20);
    }
    expect(report.strength).toBe('partial-clear');
  });

  it('passes a caller fetch failure through as the reason', () => {
    const report = findObjectReferences(
      { kind: 'script', id: 5 },
      { policies: { unavailable: true, reason: 'HTTP 403 on proclassic/policies' } },
    );
    expect(report.notChecked[0]?.sourceKind).toBe('policy');
    expect(report.notChecked[0]?.reason).toContain('403');
    // Nothing was read at all, so this is the absence of an answer.
    expect(report.strength).toBe('unchecked');
    expect(report.verdict).toContain('NOT evidence');
  });

  it('reports "unchecked", not a clean result, when no collection is supplied', () => {
    const report = findObjectReferences({ kind: 'package', id: 42 }, {});
    expect(report.references).toEqual([]);
    expect(report.strength).toBe('unchecked');
    expect(report.checked).toEqual([]);
    expect(report.notChecked).toHaveLength(REFERENCE_MATRIX.package.length);
  });

  it('reaches "clear" only with full matrix coverage', () => {
    const partial = findObjectReferences({ kind: 'package', id: 42 }, { policies: [policy({})] });
    expect(partial.strength).toBe('partial-clear');

    const full = findObjectReferences(
      { kind: 'package', id: 42 },
      {
        policies: [policy({})],
        patchPolicies: [{ general: { id: 1, name: 'Imaginary Patch Policy' }, package_configuration: { packages: [] } }],
        computerPrestages: [{ id: 'deadbeef-0000-4000-8000-000000000001', displayName: 'Imaginary Prestage', customPackageIds: [] }],
      },
    );
    expect(full.strength).toBe('clear');
    expect(full.notChecked).toEqual([]);
    expect(full.verdict).toContain('strongest negative result');
  });

  it('names source kinds that held zero objects instead of hiding them', () => {
    const report = findObjectReferences(
      { kind: 'script', id: 5 },
      { policies: [] },
    );
    expect(report.checkedButEmpty).toEqual(['policy']);
    expect(report.verdict).toContain('held zero objects');
  });

  // A collection is only checked in the sense the shape allowed. A tenant whose
  // blueprints look nothing like the candidate paths must not read as a clean bill.
  it('counts objects with no readable container and refuses to call that clear', () => {
    const report = findObjectReferences(
      { kind: 'computerGroup', name: GROUP },
      {
        blueprints: [{ id: 'deadbeef-0000-4000-8000-000000000002', name: 'Imaginary Blueprint' }],
        policies: [policy({})],
        configurationProfiles: [{ general: { id: 1, name: 'Imaginary Profile' }, scope: { computer_groups: [] } }],
        computerGroups: [],
        eBooks: [],
        restrictedSoftware: [],
        advancedComputerSearches: [],
        appInstallers: [],
      },
    );
    const blueprints = report.checked.find((c) => c.sourceKind === 'blueprint');
    expect(blueprints?.objectsRead).toBe(1);
    expect(blueprints?.objectsWithNoReadableContainer).toBe(1);
    expect(blueprints?.containersRead).toEqual([]);
    expect(report.notChecked).toEqual([]);
    expect(report.strength).toBe('partial-clear');
    expect(report.verdict).toContain('no container this tool knows how to read');
  });

  it('treats an empty container as read, not as an unreadable shape', () => {
    const report = findObjectReferences(
      { kind: 'computerGroup', name: GROUP },
      { policies: [policy({ scope: { computer_groups: [], exclusions: { computer_groups: [] } } })] },
    );
    const policies = report.checked.find((c) => c.sourceKind === 'policy');
    expect(policies?.objectsWithNoReadableContainer).toBe(0);
    expect(policies?.containersRead).toEqual(['scope.computer_groups', 'scope.exclusions.computer_groups']);
  });

  // A static group has no criteria, so its silence is a fact rather than a gap —
  // counting it as unreadable would permanently pin every tenant to partial-clear.
  it('marks a static group not-applicable rather than unreadable', () => {
    const report = findObjectReferences(
      { kind: 'computerGroup', name: GROUP },
      { computerGroups: [{ id: 1, name: 'Imaginary Static Group', is_smart: false }] },
    );
    const groups = report.checked.find((c) => c.sourceKind === 'computerGroup');
    expect(groups?.objectsNotApplicable).toBe(1);
    expect(groups?.objectsWithNoReadableContainer).toBe(0);
    expect(groups?.notApplicableReasons[0]).toContain('static');
  });

  it('counts a smart group with no criteria array as unreadable, not as empty', () => {
    const report = findObjectReferences(
      { kind: 'computerGroup', name: GROUP },
      { computerGroups: [{ id: 1, name: 'Imaginary Smart Group', is_smart: true }] },
    );
    const groups = report.checked.find((c) => c.sourceKind === 'computerGroup');
    expect(groups?.objectsWithNoReadableContainer).toBe(1);
  });
});

describe('findObjectReferences — shapes and refusals', () => {
  it('finds a script in a policy script slot and reports its priority', () => {
    const report = findObjectReferences(
      { kind: 'script', id: 5, name: 'imaginary-bootstrap.sh' },
      { policies: [policy({ scripts: [{ id: 5, name: 'imaginary-bootstrap.sh', priority: 'Before' }] })] },
    );
    expect(report.references[0]?.path).toBe('scripts[0]');
    expect(report.references[0]?.detail).toBe('priority Before');
  });

  it('only consults the source kinds the matrix allows for the target', () => {
    // A script is referenced by policies only, so a group-shaped source must be
    // neither checked nor reported as a gap.
    const report = findObjectReferences(
      { kind: 'script', id: 5 },
      { policies: [policy({ scripts: [{ id: 5 }] })], computerGroups: [groupWithMembership('X', 1, GROUP)] },
    );
    expect(report.checked.map((c) => c.sourceKind)).toEqual(['policy']);
    expect(report.notChecked).toEqual([]);
  });

  it('reads a group reference out of an advanced search criterion', () => {
    const report = findObjectReferences(
      { kind: 'computerGroup', name: GROUP },
      {
        advancedComputerSearches: [
          {
            id: 3,
            name: 'Imaginary Saved Report',
            criteria: [
              { name: 'Operating System Version', search_type: 'like', value: '15' },
              { name: 'Computer Group', search_type: 'member of', value: GROUP },
            ],
            display_fields: [{ name: 'Computer Name' }],
          },
        ],
      },
    );
    expect(report.references).toHaveLength(1);
    expect(report.references[0]?.sourceKind).toBe('advancedComputerSearch');
    expect(report.references[0]?.path).toBe('criteria[1]');
  });

  it('reads a scalar smart-group id on an app installer', () => {
    const report = findObjectReferences(
      { kind: 'computerGroup', id: 7, name: GROUP },
      { appInstallers: [{ id: 9, name: 'Imaginary App Installer', deployment: { smartGroupId: '7' } }] },
    );
    expect(report.references).toHaveLength(1);
    expect(report.references[0]?.path).toBe('deployment.smartGroupId');
    expect(report.references[0]?.matchedOn).toBe('id');
  });

  it('reads a bare id string out of a prestage package list', () => {
    const report = findObjectReferences(
      { kind: 'package', id: 42 },
      {
        computerPrestages: [
          { id: 'deadbeef-0000-4000-8000-000000000003', displayName: 'Imaginary Prestage', customPackageIds: ['41', '42'] },
        ],
      },
    );
    expect(report.references).toHaveLength(1);
    expect(report.references[0]?.path).toBe('customPackageIds[1]');
    expect(report.references[0]?.sourceName).toBe('Imaginary Prestage');
  });

  // Jamf shapes here are only partly confirmed, and a TypeError mid-audit loses
  // every finding already collected.
  it('never throws on a malformed source object', () => {
    expect(() =>
      findObjectReferences(
        { kind: 'computerGroup', id: 7, name: GROUP },
        {
          policies: [
            null,
            42,
            'not an object',
            { scope: 'not an object either' },
            { scope: { computer_groups: 'not an array' } },
            { scope: { computer_groups: [null, 7, { id: null }, { name: 123 }] } },
          ],
        },
      ),
    ).not.toThrow();
  });

  it('refuses a target it cannot match anything against', () => {
    expect(() => findObjectReferences({ kind: 'computerGroup' }, { policies: [] })).toThrow(
      /neither a usable id nor a name/,
    );
  });

  it('refuses an unknown target kind, naming the ones it knows', () => {
    expect(() =>
      findObjectReferences({ kind: 'mobileDeviceGroup' as 'computerGroup', id: 1 }, {}),
    ).toThrow(/unknown target kind/);
  });

  it('refuses a sources argument it cannot read', () => {
    expect(() =>
      findObjectReferences({ kind: 'package', id: 42 }, null as unknown as Record<string, never>),
    ).toThrow(/Refusing to treat an unreadable input/);
  });
});

describe('readGroupMembershipCriteria', () => {
  it('exposes the criterion name it looks for', () => {
    expect(GROUP_MEMBERSHIP_CRITERION_NAMES).toContain('Computer Group');
  });

  it('separates "no criteria array" from "an empty criteria array"', () => {
    expect(readGroupMembershipCriteria(undefined).readable).toBe(false);
    expect(readGroupMembershipCriteria([]).readable).toBe(true);
  });

  it('matches the criterion name exactly, not as a substring', () => {
    const read = readGroupMembershipCriteria([
      { name: 'Computer Group Name', search_type: 'is', value: GROUP },
      { name: 'computer group', search_type: 'member of', value: OTHER_GROUP },
    ]);
    expect(read.found.map((c) => c.groupName)).toEqual([OTHER_GROUP]);
  });

  it('counts a membership criterion whose value cannot be read', () => {
    const read = readGroupMembershipCriteria([{ name: 'Computer Group', search_type: 'member of', value: null }]);
    expect(read.found).toEqual([]);
    expect(read.unreadableValues).toBe(1);
  });

  it('treats any search type containing "not" as negated', () => {
    expect(isNegatedMembershipSearchType('not member of')).toBe(true);
    expect(isNegatedMembershipSearchType('member of')).toBe(false);
    expect(isNegatedMembershipSearchType(undefined)).toBe(false);
  });
});

describe('buildGroupDependencyGraph', () => {
  it('builds a node per group and an edge per membership criterion', () => {
    const graph = buildGroupDependencyGraph([
      groupWithMembership('Imaginary Tier Two', 2, 'Imaginary Tier One'),
      { id: 1, name: 'Imaginary Tier One', is_smart: true, criteria: [] },
    ]);
    expect(graph.nodes.map((n) => n.name)).toEqual(['Imaginary Tier Two', 'Imaginary Tier One']);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      fromName: 'Imaginary Tier Two',
      fromId: '2',
      toName: 'Imaginary Tier One',
      toId: '1',
      negated: false,
      criterionIndex: 0,
    });
    expect(graph.dangling).toEqual([]);
  });

  it('resolves a criterion name case-insensitively but keeps the target spelling', () => {
    const graph = buildGroupDependencyGraph([
      groupWithMembership('Imaginary Tier Two', 2, 'IMAGINARY TIER ONE'),
      { id: 1, name: 'Imaginary Tier One', is_smart: true, criteria: [] },
    ]);
    expect(graph.edges[0]?.toName).toBe('Imaginary Tier One');
    expect(graph.dangling).toEqual([]);
  });

  // A renamed or deleted group leaves criteria naming a string that resolves to
  // nothing, and the dependent group then evaluates against nothing at all.
  it('reports an edge to a name no group has, rather than dropping it', () => {
    const graph = buildGroupDependencyGraph([
      groupWithMembership('Imaginary Tier Two', 2, 'Group That Was Renamed'),
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.dangling).toHaveLength(1);
    expect(graph.dangling[0]).toMatchObject({
      fromName: 'Imaginary Tier Two',
      toName: 'Group That Was Renamed',
    });
  });

  it('records a negated criterion as a negated edge', () => {
    const graph = buildGroupDependencyGraph([
      groupWithMembership('Imaginary Tier Two', 2, 'Imaginary Tier One', 'not member of'),
      { id: 1, name: 'Imaginary Tier One', is_smart: true, criteria: [] },
    ]);
    expect(graph.edges[0]?.negated).toBe(true);
    expect(graph.edges[0]?.searchType).toBe('not member of');
  });

  it('lists a smart group whose criteria could not be read', () => {
    const graph = buildGroupDependencyGraph([{ id: 1, name: 'Imaginary Broken Group', is_smart: true }]);
    expect(graph.unreadable).toHaveLength(1);
    expect(graph.unreadable[0]?.why).toContain('criteria');
  });

  it('does not call a static group unreadable', () => {
    const graph = buildGroupDependencyGraph([{ id: 1, name: 'Imaginary Static Group', is_smart: false }]);
    expect(graph.unreadable).toEqual([]);
    expect(graph.nodes).toHaveLength(1);
  });

  it('keeps a nameless or non-object entry as unreadable instead of skipping it', () => {
    const graph = buildGroupDependencyGraph([{ id: 1, is_smart: true, criteria: [] }, null, 'nope']);
    expect(graph.nodes).toEqual([]);
    expect(graph.unreadable).toHaveLength(3);
    expect(graph.unreadable.map((u) => u.why)).toContain('entry is not an object');
  });

  // Criteria reference groups by name, so a duplicate name makes every edge into
  // it ambiguous.
  it('flags duplicate group names', () => {
    const graph = buildGroupDependencyGraph([
      { id: 1, name: 'Imaginary Duplicate', is_smart: true, criteria: [] },
      { id: 2, name: 'imaginary duplicate', is_smart: true, criteria: [] },
    ]);
    expect(graph.duplicateNames).toEqual([{ name: 'Imaginary Duplicate', ids: ['1', '2'] }]);
  });

  it('refuses input that is not an array rather than returning an empty graph', () => {
    expect(() => buildGroupDependencyGraph(undefined as unknown as unknown[])).toThrow(
      /Refusing to return an empty graph/,
    );
  });
});

describe('findGroupDependencyCycles', () => {
  it('returns the node path of a two-group cycle, once', () => {
    const graph = buildGroupDependencyGraph([
      groupWithMembership('Imaginary Alpha', 1, 'Imaginary Beta'),
      groupWithMembership('Imaginary Beta', 2, 'Imaginary Alpha'),
    ]);
    const report = findGroupDependencyCycles(graph);
    expect(report.hasCycle).toBe(true);
    expect(report.cycles).toHaveLength(1);
    expect(report.cycles[0]?.path).toEqual(['Imaginary Alpha', 'Imaginary Beta', 'Imaginary Alpha']);
    expect(report.truncated).toBe(false);
  });

  it('finds a self-referencing group and says so', () => {
    const graph = buildGroupDependencyGraph([groupWithMembership('Imaginary Ouroboros', 1, 'Imaginary Ouroboros')]);
    const report = findGroupDependencyCycles(graph);
    expect(report.cycles).toHaveLength(1);
    expect(report.cycles[0]?.selfReference).toBe(true);
    expect(report.cycles[0]?.path).toEqual(['Imaginary Ouroboros', 'Imaginary Ouroboros']);
  });

  it('returns every distinct cycle, not just the first', () => {
    const graph = buildGroupDependencyGraph([
      groupWithMembership('Imaginary Alpha', 1, 'Imaginary Beta'),
      {
        id: 2,
        name: 'Imaginary Beta',
        is_smart: true,
        criteria: [
          { name: 'Computer Group', search_type: 'member of', value: 'Imaginary Alpha' },
          { name: 'Computer Group', search_type: 'member of', value: 'Imaginary Gamma' },
        ],
      },
      groupWithMembership('Imaginary Gamma', 3, 'Imaginary Alpha'),
    ]);
    const report = findGroupDependencyCycles(graph);
    const paths = report.cycles.map((c) => c.path.join(' → ')).sort();
    expect(paths).toEqual([
      'Imaginary Alpha → Imaginary Beta → Imaginary Alpha',
      'Imaginary Alpha → Imaginary Beta → Imaginary Gamma → Imaginary Alpha',
    ]);
  });

  it('reports no cycle for an acyclic chain', () => {
    const graph = buildGroupDependencyGraph([
      groupWithMembership('Imaginary Alpha', 1, 'Imaginary Beta'),
      groupWithMembership('Imaginary Beta', 2, 'Imaginary Gamma'),
      { id: 3, name: 'Imaginary Gamma', is_smart: true, criteria: [] },
    ]);
    const report = findGroupDependencyCycles(graph);
    expect(report.hasCycle).toBe(false);
    expect(report.cycles).toEqual([]);
  });

  // Enumeration is exponential in the worst case, so it can stop. "Is there a
  // cycle" must not stop with it, or a truncated run reports a clean graph.
  it('keeps hasCycle authoritative when enumeration is truncated', () => {
    const graph = buildGroupDependencyGraph([
      groupWithMembership('Imaginary Alpha', 1, 'Imaginary Beta'),
      groupWithMembership('Imaginary Beta', 2, 'Imaginary Alpha'),
    ]);
    const report = findGroupDependencyCycles(graph, { maxCycles: 0 });
    expect(report.cycles).toEqual([]);
    expect(report.truncated).toBe(true);
    expect(report.hasCycle).toBe(true);
    expect(report.note).toContain('incomplete');
  });
});

describe('findGroupBlastRadius', () => {
  const chain = () =>
    buildGroupDependencyGraph([
      groupWithMembership('Imaginary Alpha', 1, 'Imaginary Beta'),
      groupWithMembership('Imaginary Beta', 2, 'Imaginary Gamma'),
      { id: 3, name: 'Imaginary Gamma', is_smart: true, criteria: [] },
    ]);

  it('walks dependants backwards up the chain with a depth each', () => {
    const radius = findGroupBlastRadius(chain(), 'Imaginary Gamma');
    expect(radius.groupFound).toBe(true);
    expect(radius.dependants.map((d) => [d.name, d.depth])).toEqual([
      ['Imaginary Beta', 1],
      ['Imaginary Alpha', 2],
    ]);
    expect(radius.maxDepth).toBe(2);
    expect(radius.dependants[1]?.via).toEqual(['Imaginary Gamma', 'Imaginary Beta', 'Imaginary Alpha']);
  });

  // Direction is easy to invert. The group at the top of the chain has nothing
  // depending on it; only the reverse walk gives that answer.
  it('does not confuse dependants with dependencies', () => {
    expect(findGroupBlastRadius(chain(), 'Imaginary Alpha').dependants).toEqual([]);
  });

  it('resolves a group by id as well as by name', () => {
    const radius = findGroupBlastRadius(chain(), '3');
    expect(radius.group).toBe('Imaginary Gamma');
    expect(radius.dependants).toHaveLength(2);
  });

  // Jamf permits configurations that never converge; the walk must end anyway.
  it('terminates on cyclic input and names the cycle', () => {
    const graph = buildGroupDependencyGraph([
      groupWithMembership('Imaginary Alpha', 1, 'Imaginary Beta'),
      groupWithMembership('Imaginary Beta', 2, 'Imaginary Alpha'),
    ]);
    const radius = findGroupBlastRadius(graph, 'Imaginary Alpha');
    expect(radius.dependants.map((d) => d.name)).toEqual(['Imaginary Beta']);
    expect(radius.inCycleWith).toEqual(['Imaginary Beta']);
    expect(radius.note).toContain('cycle');
  });

  it('terminates on a longer cycle too, visiting each group once', () => {
    const graph = buildGroupDependencyGraph([
      groupWithMembership('Imaginary Alpha', 1, 'Imaginary Beta'),
      groupWithMembership('Imaginary Beta', 2, 'Imaginary Gamma'),
      groupWithMembership('Imaginary Gamma', 3, 'Imaginary Alpha'),
    ]);
    const radius = findGroupBlastRadius(graph, 'Imaginary Alpha');
    expect(radius.dependants.map((d) => d.name)).toEqual(['Imaginary Gamma', 'Imaginary Beta']);
    expect(radius.dependants.map((d) => d.depth)).toEqual([1, 2]);
  });

  it('marks a chain that passes through a "not member of" criterion', () => {
    const graph = buildGroupDependencyGraph([
      groupWithMembership('Imaginary Alpha', 1, 'Imaginary Beta', 'not member of'),
      groupWithMembership('Imaginary Beta', 2, 'Imaginary Gamma'),
      { id: 3, name: 'Imaginary Gamma', is_smart: true, criteria: [] },
    ]);
    const radius = findGroupBlastRadius(graph, 'Imaginary Gamma');
    expect(radius.dependants.find((d) => d.name === 'Imaginary Beta')?.throughNegatedCriterion).toBe(false);
    expect(radius.dependants.find((d) => d.name === 'Imaginary Alpha')?.throughNegatedCriterion).toBe(true);
    expect(radius.note).toContain('not member of');
  });

  // An empty list for a group that is not in the graph would read as "nothing
  // depends on it", which is the false all-clear this module exists to prevent.
  it('says the group was not found instead of returning an empty radius', () => {
    const radius = findGroupBlastRadius(chain(), 'Group That Does Not Exist');
    expect(radius.groupFound).toBe(false);
    expect(radius.dependants).toEqual([]);
    expect(radius.note).toContain('not a finding');
  });

  it('warns that unreadable groups may hide part of the radius', () => {
    const graph = buildGroupDependencyGraph([
      groupWithMembership('Imaginary Alpha', 1, 'Imaginary Beta'),
      { id: 2, name: 'Imaginary Beta', is_smart: true, criteria: [] },
      { id: 3, name: 'Imaginary Broken Group', is_smart: true },
    ]);
    const radius = findGroupBlastRadius(graph, 'Imaginary Beta');
    expect(radius.note).toContain('could not be read');
  });

  it('refuses a blank group argument', () => {
    expect(() => findGroupBlastRadius(chain(), '   ')).toThrow(/Refusing to return an empty blast radius/);
  });
});
