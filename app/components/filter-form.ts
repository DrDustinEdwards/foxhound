import type { ComponentProps } from "react";
import { Form } from "react-router";
import type { FilterBar } from "capsomer/react/filter-bar";

// React Router's Form for Capsomer's FilterBar, which takes it for a client navigation. The bar's
// own FormLike type has `method` as a string where React Router's is its HTMLFormMethod, so the
// two do not line up until Capsomer widens it; the bar always sends its form as GET.
export const FilterForm = Form as unknown as ComponentProps<typeof FilterBar>["Form"];
