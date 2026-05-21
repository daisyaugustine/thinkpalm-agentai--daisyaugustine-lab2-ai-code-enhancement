import logger from '../config/loggerConfig';
import { col, fn, literal } from 'sequelize';
import CrewDetails from '../models/crewDetails';

export const uniqueDuplicateCrewUpdate = async (): Promise<string> => {
  try {
    logger.info(`Crew Unique Constraint Duplicate Update Start`);

    const passportDuplicateQuery = await CrewDetails.findAll({
      attributes: ['passport_no',
        [fn('COUNT', col('passport_no')), 'count'],
        [fn('array_agg', col('id')), 'ids'],
      ],
      group: ['passport_no'],
      having: literal('COUNT("passport_no") > 1'),
    })

    const seamanDuplicateQuery = CrewDetails.findAll({
      attributes: ['seaman_book_no',
        [fn('COUNT', col('seaman_book_no')), 'count'],
        [fn('array_agg', col('id')), 'ids'],
      ],
      group: ['seaman_book_no'],
      having: literal('COUNT("seaman_book_no") > 1'),
    })

    const payrollDuplicateQuery = CrewDetails.findAll({
      attributes: ['payroll_no',
        [fn('COUNT', col('payroll_no')), 'count'],
        [fn('array_agg', col('id')), 'ids'],
      ],
      group: ['payroll_no'],
      having: literal('COUNT("payroll_no") > 1'),
    })

    const [passportDuplicateData,
      seamanDuplicateData,
      payrollDuplicateData] =
      await Promise.all([passportDuplicateQuery,
        seamanDuplicateQuery,
        payrollDuplicateQuery]);

    if(!(passportDuplicateData?.length &&
      seamanDuplicateData?.length &&
      payrollDuplicateData?.length)) {
      logger.info(`No Crew Duplicate To Update - 
        Duplicate length below
        Passport ${passportDuplicateData?.length},
        Seaman ${seamanDuplicateData?.length},
        Payroll ${payrollDuplicateData?.length}`);
      return "";
    }

    let duplicateUpdate: any = {};

    if (passportDuplicateData?.length) {
      passportDuplicateData.forEach((data: any) => {
        (data?.dataValues?.ids || []).forEach((id: any) => {
          duplicateUpdate[id] = {
            passport_no: null
          }
        })
      })
    }

    if (seamanDuplicateData?.length) {
      seamanDuplicateData.forEach((data: any) => {
        (data?.dataValues?.ids || []).forEach((id: any) => {
          if (duplicateUpdate[id])
            duplicateUpdate[id].seaman_book_no = null;
          else duplicateUpdate[id] = {
            seaman_book_no: null
          }
        })
      })
    }

    if (payrollDuplicateData?.length) {
      payrollDuplicateData.forEach((data: any) => {
        (data?.dataValues?.ids || []).forEach((id: any) => {
          if (duplicateUpdate[id])
            duplicateUpdate[id].payroll_no = null;
          else duplicateUpdate[id] = {
            payroll_no: null
          }
        })
      })
    }

    for (const crewId in duplicateUpdate) {
      await CrewDetails.update(
        duplicateUpdate[crewId], {
        where: {
          id: crewId
        },
      })
      logger.info(`Crew Duplicate Update successfully - id ${crewId}`);
    }

    return 'Successfully Updated'
  } catch (e) {
    throw e;
  }
}
