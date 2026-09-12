/**
 * Perfil da escola, espelhado de `agent_framework_backend/v2/school.py`.
 *
 * Vive aqui, e nao no seletor da v1, porque e o contrato entre a interface e o
 * backend: qualquer campo novo tem de existir dos dois lados.
 */
export interface SchoolData {
  id: string;
  name: string;
  district: string;
  city: string;
  state: string;
  zip: string;
  students: number;
  grades: string;
  type: 'Public' | 'Charter' | 'Private';
  demographics: {
    freeReducedLunch: number;
    minorityEnrollment: number;
    englishLearners: number;
  };
  programs: {
    stem: boolean;
    cte: boolean;
    specialEd: boolean;
    titleI: boolean;
  };
  contact: {
    phone: string;
    website?: string;
  };
}
