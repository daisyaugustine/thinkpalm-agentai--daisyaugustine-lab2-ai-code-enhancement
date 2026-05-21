import logger from '../config/loggerConfig';
import {
  col,
  fn,
  literal,
  Op,
  Transaction,
  WhereOptions,
} from 'sequelize';
import sequelize from '../data/db';
import CrewDetails, { CrewListAttributes } from '../models/crewDetails';

const UPDATE_BATCH_SIZE = 50;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DuplicateUniqueField = keyof Pick<
  CrewListAttributes,
  'passport_no' | 'seaman_book_no' | 'payroll_no'
>;

const DUPLICATE_FIELDS: readonly DuplicateUniqueField[] = [
  'passport_no',
  'seaman_book_no',
  'payroll_no',
] as const;

type DuplicateAggregateRow = {
  count?: string | number;
  ids?: string[] | string | number | number[];
  dataValues?: {
    ids?: string[] | string | number | number[];
    count?: string | number;
  };
} & Partial<Pick<CrewListAttributes, DuplicateUniqueField>>;

type CrewDuplicateNullUpdate = Partial<{
  passport_no: null;
  seaman_book_no: null;
  payroll_no: null;
}>;

type DuplicateUpdateMap = Record<CrewListAttributes['id'], CrewDuplicateNullUpdate>;

type DuplicateGroupsResult = Record<
  DuplicateUniqueField,
  DuplicateAggregateRow[]
>;

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const logAndRethrow = (context: string, error: unknown): never => {
  logger.error(`${context}: ${getErrorMessage(error)}`);
  throw error;
};

const runAsync = async <T>(context: string, fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (error: unknown) {
    return logAndRethrow(context, error);
  }
};

const runSync = <T>(context: string, fn: () => T): T => {
  try {
    return fn();
  } catch (error: unknown) {
    return logAndRethrow(context, error);
  }
};

const normalizedFieldExpr = (field: DuplicateUniqueField) =>
  fn('LOWER', fn('TRIM', col(field)));

const activeCrewWhere = (): WhereOptions<CrewListAttributes> =>
  ({
    [Op.or]: [
      { is_deleted: false },
      { is_deleted: { [Op.is]: null } },
    ],
  }) as WhereOptions<CrewListAttributes>;

const nonEmptyFieldWhere = (field: DuplicateUniqueField): WhereOptions<CrewListAttributes> => ({
  [Op.and]: [
    activeCrewWhere(),
    { [field]: { [Op.ne]: null } },
    { [field]: { [Op.ne]: '' } },
    sequelize.where(normalizedFieldExpr(field), { [Op.ne]: '' }),
  ],
});

const parsePostgresArrayString = (value: string): string[] => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return [];
  }
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) {
    return [];
  }
  return inner
    .split(',')
    .map((part) => part.trim().replace(/^"(.*)"$/, '$1'))
    .filter((part) => part.length > 0);
};

const getRawIdsFromRow = (row: DuplicateAggregateRow): unknown =>
  row.ids !== undefined ? row.ids : row.dataValues?.ids;

const parseAggregatedIds = (row: DuplicateAggregateRow): CrewListAttributes['id'][] =>
  runSync('Failed to parse aggregated crew ids', () => {
    const raw = getRawIdsFromRow(row);
    let parsed: string[] = [];

    if (Array.isArray(raw)) {
      parsed = raw.map(String);
    } else if (typeof raw === 'string') {
      const fromPgArray = parsePostgresArrayString(raw);
      parsed = fromPgArray.length > 0 ? fromPgArray : [raw];
    } else if (raw != null) {
      parsed = [String(raw)];
    }

    return parsed
      .map((id) => id.trim())
      .filter((id) => UUID_REGEX.test(id));
  });

const getDuplicateGroupLabel = (
  row: DuplicateAggregateRow,
  field: DuplicateUniqueField,
): string => String(row[field] ?? 'unknown');

const setFieldNullOnCrew = (
  duplicateUpdate: DuplicateUpdateMap,
  crewId: CrewListAttributes['id'],
  field: DuplicateUniqueField,
): void => {
  const existing = duplicateUpdate[crewId];
  duplicateUpdate[crewId] = existing
    ? { ...existing, [field]: null }
    : { [field]: null };
};

const findDuplicateGroups = (
  field: DuplicateUniqueField,
): Promise<DuplicateAggregateRow[]> =>
  runAsync(`Failed to find duplicate crew groups for ${field}`, async () => {
    const normalized = normalizedFieldExpr(field);
    const rows = await CrewDetails.findAll({
      attributes: [
        [normalized, field],
        [fn('COUNT', col('id')), 'count'],
        [literal('array_agg("id" ORDER BY "id" ASC)'), 'ids'],
      ],
      where: nonEmptyFieldWhere(field),
      group: [normalized],
      having: literal('COUNT("id") > 1'),
      raw: true,
      subQuery: false,
    });
    return rows as DuplicateAggregateRow[];
  });

const findAllDuplicateGroups = (): Promise<DuplicateGroupsResult> =>
  runAsync('Failed to load duplicate crew groups', async () => {
    const [passport, seaman, payroll] = await Promise.all(
      DUPLICATE_FIELDS.map((field) => findDuplicateGroups(field)),
    );
    return {
      passport_no: passport,
      seaman_book_no: seaman,
      payroll_no: payroll,
    };
  });

const hasDuplicateGroups = (groups: DuplicateGroupsResult): boolean =>
  DUPLICATE_FIELDS.some((field) => groups[field].length > 0);

const markDuplicateIdsForNulling = (
  rows: DuplicateAggregateRow[],
  field: DuplicateUniqueField,
  duplicateUpdate: DuplicateUpdateMap,
): void =>
  runSync(`Failed to mark duplicate ids for nulling on ${field}`, () => {
    for (const row of rows) {
      const ids = parseAggregatedIds(row);
      const groupLabel = getDuplicateGroupLabel(row, field);
      const count = Number(row.count ?? row.dataValues?.count ?? 0);

      if (ids.length === 0) {
        logger.warn(
          `Skipping duplicate group for ${field}="${groupLabel}": no parseable crew ids (count=${count})`,
        );
        continue;
      }

      if (count > 1 && ids.length < 2) {
        logger.warn(
          `Duplicate group for ${field}="${groupLabel}" has count ${count} but only ${ids.length} parseable id(s)`,
        );
      }

      for (const id of ids) {
        setFieldNullOnCrew(duplicateUpdate, id, field);
      }
    }
  });

const buildDuplicateUpdateMap = (groups: DuplicateGroupsResult): DuplicateUpdateMap =>
  runSync('Failed to build duplicate crew update map', () => {
    const duplicateUpdate: DuplicateUpdateMap = {};

    for (const field of DUPLICATE_FIELDS) {
      if (groups[field].length > 0) {
        markDuplicateIdsForNulling(groups[field], field, duplicateUpdate);
      }
    }

    return duplicateUpdate;
  });

const updateCrewDuplicateRecord = (
  crewId: CrewListAttributes['id'],
  update: CrewDuplicateNullUpdate,
  transaction: Transaction,
): Promise<void> =>
  runAsync(`Failed to update crew duplicate fields for id ${crewId}`, async () => {
    const [affectedCount] = await CrewDetails.update(
      update as Parameters<typeof CrewDetails.update>[0],
      {
        where: { id: crewId },
        transaction,
      },
    );

    if (!affectedCount) {
      throw new Error(`No crew row updated for id ${crewId}`);
    }
  });

const rollbackTransaction = (transaction: Transaction): Promise<void> =>
  runAsync('Failed to roll back crew duplicate update transaction', () =>
    transaction.rollback(),
  );

const applyCrewDuplicateUpdates = (
  duplicateUpdate: DuplicateUpdateMap,
): Promise<void> =>
  runAsync('Failed to apply crew duplicate updates', async () => {
    const crewIds = Object.keys(duplicateUpdate) as CrewListAttributes['id'][];
    const transaction = await sequelize.transaction();

    try {
      logger.info(
        `Applying crew duplicate updates in transaction (${crewIds.length} crew)`,
      );

      for (let i = 0; i < crewIds.length; i += UPDATE_BATCH_SIZE) {
        const batch = crewIds.slice(i, i + UPDATE_BATCH_SIZE);
        await Promise.all(
          batch.map((crewId) =>
            updateCrewDuplicateRecord(
              crewId,
              duplicateUpdate[crewId],
              transaction,
            ),
          ),
        );
      }

      await transaction.commit();
      logger.info(`Committed crew duplicate updates for ${crewIds.length} crew`);
    } catch (error: unknown) {
      await rollbackTransaction(transaction).catch(() => undefined);
      logger.error(
        `Rolled back crew duplicate updates (${crewIds.length} crew); no partial changes applied: ${getErrorMessage(error)}`,
      );
      throw error;
    }
  });

/**
 * Runs once at server startup (after DB init) to clear duplicate unique values before constraints apply.
 * Sets `passport_no`, `seaman_book_no`, and/or `payroll_no` to null on every crew row in a duplicate group.
 * Returns `''` if there is nothing to update; `'Successfully Updated'` if all changes committed; throws on failure.
 */
export const uniqueConstraintDuplicateCrewUpdate = (): Promise<string> =>
  runAsync('Crew Unique Constraint Duplicate Update', async () => {
    logger.info('Crew Unique Constraint Duplicate Update Start');

    const groups = await findAllDuplicateGroups();

    if (!hasDuplicateGroups(groups)) {
      logger.info(
        `No Crew Duplicate To Update - Passport ${groups.passport_no.length}, ` +
        `Seaman ${groups.seaman_book_no.length}, Payroll ${groups.payroll_no.length}`,
      );
      return '';
    }

    const duplicateUpdate = buildDuplicateUpdateMap(groups);
    const crewIds = Object.keys(duplicateUpdate);

    if (crewIds.length === 0) {
      throw new Error(
        'Duplicate groups were found but no crew ids could be resolved from array_agg results',
      );
    }

    await applyCrewDuplicateUpdates(duplicateUpdate);

    logger.info(
      `Crew Unique Constraint Duplicate Update End - ${crewIds.length} crew updated`,
    );
    return 'Successfully Updated';
  });
